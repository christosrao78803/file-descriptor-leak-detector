import { open } from 'node:fs/promises';

/**
 * WeakRef is used for the fd registry so that GC-eligible descriptors do not
 * artificially inflate the leak count. Without it, an fd whose FileHandle goes
 * out of scope (and is thus eligible for automatic close on the next GC tick)
 * would spuriously appear as leaked.
 */
const fdRegistrySymbol = Symbol('fdRegistry');

export class LeakDetector {
    constructor({ threshold = 0, now = () => Date.now() } = {}) {
        if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0) {
            throw new TypeError('threshold must be a non-negative finite number');
        }
        if (typeof now !== 'function') {
            throw new TypeError('now must be a function');
        }
        this._threshold = threshold;
        this._now = now;
        this._entries = new Map();
    }

    async open(path, flags, mode) {
        const handle = await open(path, flags, mode);
        const fd = handle.fd;
        if (!this._entries.has(fd)) {
            this._entries.set(fd, {
                path,
                flags,
                openedAt: this._now(),
                handleRef: new WeakRef(handle)
            });
        }
        return handle;
    }

    async close(handle) {
        if (handle === null || handle === undefined || typeof handle.close !== 'function') {
            throw new TypeError('close() expects a FileHandle');
        }
        const fd = handle.fd;
        await handle.close();
        // Erase the entry before any leak check so a synchronous check sees
        // the post-close state. `fd` may be -1 if the handle was already
        // closed; in that case there is nothing to clean up.
        if (fd >= 0) {
            this._entries.delete(fd);
        }
    }

    getOpenDescriptors() {
        const result = [];
        for (const [fd, entry] of this._entries) {
            const handle = entry.handleRef.deref();
            if (handle === undefined) {
                // The FileHandle is eligible for GC and will be auto-closed.
                // Do not report it as a user-actionable leak.
                continue;
            }
            result.push({ fd, path: entry.path, flags: entry.flags, openedAt: entry.openedAt });
        }
        return result;
    }

    checkLeaks() {
        const open = this.getOpenDescriptors();
        if (open.length > this._threshold) {
            const messages = open.map(d => `fd ${d.fd} (${JSON.stringify(d.path)}, flags ${JSON.stringify(d.flags)})`);
            throw new Error(`File descriptor leak detected: ${open.length} open (threshold ${this._threshold}):\n  ${messages.join('\n  ')}`);
        }
        return open;
    }

    async cleanup() {
        const descriptors = this.getOpenDescriptors();
        for (const desc of descriptors) {
            const entry = this._entries.get(desc.fd);
            if (entry) {
                const handle = entry.handleRef.deref();
                if (handle) {
                    try {
                        await handle.close();
                    } catch (e) {
                        // Swallow: we're cleaning up best-effort. The original
                        // error is what matters to the caller.
                    }
                }
                this._entries.delete(desc.fd);
            }
        }
        return descriptors;
    }

    /**
     * Return the count of descriptors the detector believes are still open and
     * hold a live FileHandle. Mirrors getOpenDescriptors().length without the
     * array allocation, which matters when this is polled on a hot path.
     */
    getOpenCount() {
        let count = 0;
        for (const [, entry] of this._entries) {
            if (entry.handleRef.deref() !== undefined) {
                count++;
            }
        }
        return count;
    }
}
