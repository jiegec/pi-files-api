// Stand-in for `@earendil-works/pi-coding-agent` used only by the tests.
// The plugin only uses `getAgentDir()` at runtime; everything else is type-only
// and erased by Node's type stripping.
import { homedir } from "node:os";
import { join } from "node:path";

export function getAgentDir() {
	return process.env.PI_FILES_API_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
