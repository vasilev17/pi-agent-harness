/**
 * The replacement body. `original` is the unwrapped method itself, not bound, so
 * nothing is allocated per call: behaviors invoke it as `original.apply(self, args)`.
 */
export type MethodBehavior = (self: any, args: any[], original: (...args: any[]) => any) => any;

type HookRecord = { behavior: MethodBehavior };

/**
 * Wrap `target[method]` once per process and route every call through the
 * behavior that the most recently loaded copy of this extension supplied.
 *
 * Pi's classes and TUI outlive a /reload, but this module does not. A wrapper
 * that closed over its own code would keep running the first version until Pi
 * restarts, so the wrapper only looks up the behavior, and each load replaces it.
 * `legacy` names the markers under which older versions kept the unwrapped
 * method; their wrappers are dropped in favor of that original rather than
 * stacked beneath the new one.
 */
export function hookMethod(
	target: object,
	method: string,
	name: string,
	behavior: MethodBehavior,
	legacy: readonly symbol[] = [],
): boolean {
	const holder = target as Record<PropertyKey, any>;
	const key = Symbol.for(`pi-compact-tools.hook.${name}`);
	if (Object.hasOwn(holder, key)) {
		(holder[key] as HookRecord).behavior = behavior;
		return true;
	}
	if (typeof holder[method] !== "function") return false;
	let original: (...args: any[]) => any = holder[method];
	for (const marker of legacy) {
		if (Object.hasOwn(holder, marker) && typeof holder[marker] === "function") {
			original = holder[marker];
			break;
		}
	}
	const record: HookRecord = { behavior };
	holder[method] = function (this: unknown, ...args: any[]) {
		return record.behavior(this, args, original);
	};
	Object.defineProperty(holder, key, { value: record });
	return true;
}
