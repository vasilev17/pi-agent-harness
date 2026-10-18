import {
	createBashToolDefinition, createEditToolDefinition, createFindToolDefinition,
	createGrepToolDefinition, createLsToolDefinition, createPowerShellToolDefinition,
	createReadToolDefinition, createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// Constructing definitions does not register/activate tools or run their execute
// functions. Only renderer fingerprints are retained, never model-facing fields.
const factories = {
	read: createReadToolDefinition, write: createWriteToolDefinition, edit: createEditToolDefinition,
	bash: createBashToolDefinition, powershell: createPowerShellToolDefinition,
	grep: createGrepToolDefinition, find: createFindToolDefinition, ls: createLsToolDefinition,
};
const builtinRenderers = new Map<string, { call: string; result: string }>();
for (const [name, factory] of Object.entries(factories)) {
	try {
		const definition = factory(process.cwd());
		builtinRenderers.set(name, { call: String(definition.renderCall), result: String(definition.renderResult) });
	} catch {
		// A missing/unsupported reference renderer must not prevent UI loading.
	}
}

/** Conservative fallback on legacy hosts without source metadata. */
export function hasAuthorRenderers(name: string, definition: ToolDefinition<any, any, any> | undefined): boolean {
	if (!definition) return false;
	const builtin = builtinRenderers.get(name);
	return Boolean((definition.renderCall && String(definition.renderCall) !== builtin?.call)
		|| (definition.renderResult && String(definition.renderResult) !== builtin?.result));
}

/** Change only a transcript row's renderer shell, never a tool registry entry. */
export function refreshRowShell(row: object): void {
	const target = row as {
		children?: unknown[]; selfRenderContainer?: unknown; contentBox?: unknown; contentTextRegion?: unknown;
		hasRendererDefinition?(): boolean; getRenderShell?(): string;
		callRendererComponent?: unknown; resultRendererComponent?: unknown;
	};
	if (!Array.isArray(target.children) || !target.selfRenderContainer || !target.contentBox || !target.contentTextRegion) return;
	const wanted = target.hasRendererDefinition?.()
		? target.getRenderShell?.() === "self" ? target.selfRenderContainer : target.contentBox
		: target.contentTextRegion;
	const shells: unknown[] = [target.selfRenderContainer, target.contentBox, target.contentTextRegion];
	const index = target.children.findIndex((child) => shells.includes(child));
	if (index >= 0 && target.children[index] !== wanted) {
		target.children[index] = wanted;
		target.callRendererComponent = undefined;
		target.resultRendererComponent = undefined;
	}
}
