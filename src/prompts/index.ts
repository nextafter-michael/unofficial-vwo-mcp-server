/** Single place where every prompt is registered. See tools/index.ts for the same pattern. */

import type { McpServer } from '@modelcontextprotocol/server';

import type { ToolContext } from '../tools/shared.js';
import { registerAbTestWorkflowPrompt } from './abTestWorkflow.js';
import { registerGeneralGuidancePrompt } from './general.js';
import { registerSplitTestWorkflowPrompt } from './splitTestWorkflow.js';
import { registerWebRolloutWorkflowPrompt } from './webRolloutWorkflow.js';

export function registerAllPrompts(server: McpServer, ctx: ToolContext): void {
    registerGeneralGuidancePrompt(server, ctx);
    registerAbTestWorkflowPrompt(server, ctx);
    registerSplitTestWorkflowPrompt(server, ctx);
    registerWebRolloutWorkflowPrompt(server, ctx);
}
