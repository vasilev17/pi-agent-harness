/**
 * One shared animation clock. Every animation tick asks Pi to lay out and repaint
 * the whole screen, so the working label and the silent-mode line tick together:
 * both change inside the same callback, and Pi coalesces their requests into one
 * frame instead of two unsynchronized timers each forcing frames of their own.
 */
export const TICK_MS = 80;

type Listener = () => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | undefined;

/** Run `listener` on every tick until the returned function is called. The clock stops when idle. */
export function onTick(listener: Listener): () => void {
	listeners.add(listener);
	if (!timer) {
		timer = setInterval(() => {
			for (const tick of [...listeners]) tick();
		}, TICK_MS);
		timer.unref?.();
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size > 0 || !timer) return;
		clearInterval(timer);
		timer = undefined;
	};
}
