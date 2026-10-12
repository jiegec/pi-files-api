// Usage: node --import ./test/register.mjs --test test/*.test.ts
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
