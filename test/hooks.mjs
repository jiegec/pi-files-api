// Resolve hook: redirect the bare pi package import to the local stub so the
// plugin can be imported by Node directly, without installs or a build step.
const STUB = new URL("./pi-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "@earendil-works/pi-coding-agent") {
		return { url: STUB, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
