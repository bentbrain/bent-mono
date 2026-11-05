import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "./mcp-server.js";
import { createRuntime } from "./runtime.js";

const runtime = createRuntime();
const server = createMcpServer(runtime.config, runtime.adapter, runtime.actionStore);
const transport = new StdioServerTransport();

await server.connect(transport);
