/**
 * Single place where every tool is registered.
 *
 * One module per VWO resource area, so the tool surface stays easy to audit.
 * Every tool name carries a `vwo_` prefix — the host may namespace by server too
 * (Claude Code exposes them as `mcp__vwo__vwo_list_campaigns`), but the local
 * prefix keeps names self-describing in hosts that don't, and in any text
 * (tool descriptions, error messages) that only ever shows the bare name.
 */

import type { McpServer } from '@modelcontextprotocol/server';

import { registerCampaignTools } from './campaigns.js';
import { registerCustomWidgetTools } from './custom_widgets.js';
import { registerDiagnosticTools } from './diagnostics.js';
import { registerDraftTools } from './drafts.js';
import { registerGoalTools } from './goals.js';
import { registerLabelTools } from './labels.js';
import { registerMetricReportTools } from './metric_reports.js';
import { registerSectionTools } from './sections.js';
import type { ToolContext } from './shared.js';
import { registerTrackingCodeTools } from './tracking_code.js';
import { registerVariationTools } from './variations.js';
import { registerWorkspaceTools } from './workspaces.js';

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
    registerDiagnosticTools(server, ctx);
    registerWorkspaceTools(server, ctx);
    registerCampaignTools(server, ctx);
    registerDraftTools(server, ctx);
    registerGoalTools(server, ctx);
    registerVariationTools(server, ctx);
    registerSectionTools(server, ctx);
    registerMetricReportTools(server, ctx);
    registerLabelTools(server, ctx);
    registerTrackingCodeTools(server, ctx);
    registerCustomWidgetTools(server, ctx);
}

export type { ToolContext } from './shared.js';
