/**
 * Service layer — where business rules live (docs/03 §3, docs/13).
 *
 * A service:
 *   - enforces authorization, including OBJECT-LEVEL access, not just role checks.
 *     Route-level checks alone are a defect, because every non-HTTP caller bypasses them
 *     (docs/07, docs/17);
 *   - owns domain invariants and state-machine transitions;
 *   - runs multi-write work inside one transaction, with the audit record written in
 *     that same transaction (docs/31 §3.1);
 *   - enqueues non-immediate work via the outbox instead of awaiting it inline
 *     (docs/29 §3);
 *   - never touches `req`/`res` (enforced by ESLint) and never returns HTTP concerns.
 *
 * Domain services (`catalog`, `requests`, `incidents`, `tasks`, `sla`, `approvals`,
 * `knowledge`, `assets`) are added as their owning documents reach `Approved`
 * (docs/40). Module boundaries and permitted dependencies are listed in docs/03 §4 and
 * are enforced by an import-boundary lint rule.
 */

export { checkReadiness, type ReadinessReport } from './health.service';
export { type RequestMeta } from './context';
export {
  login,
  logout,
  resolveSession,
  requestPasswordReset,
  resetPassword,
  getIdentity,
  type AuthenticatedSession,
} from './auth.service';
export { acceptInvitation, invitationAcceptUrl, type IssuedInvitation } from './invitation.service';
export {
  provisionOrganization,
  listOrganizationsPage,
  suspendOrganization,
  activateOrganization,
  listOperators,
  platformStatus,
  type ProvisionedOrganization,
} from './platform.service';
export {
  inviteUser,
  deactivateUser,
  listTenantUsers,
  listAssignableRoles,
  type InvitedUser,
  type TenantUserSummary,
  type AssignableRole,
} from './users.service';
export {
  listCategoryTree,
  createCategory,
  updateCategory,
  listItems,
  getItem,
  createItem,
  updateItem,
  activateItem,
  retireItem,
  type CategoryView,
  type CatalogItemSummary,
  type CatalogItemDetail,
  type CatalogItemInput,
} from './catalog.service';
export { listTeams, type TeamSummary } from './teams.service';
export {
  createRequest,
  listRequestsPage,
  getRequest,
  transitionRequest,
  assignRequest,
  assertRequestVisible,
  cancelRequest,
  addComment,
  listRequestComments,
  countRequestsForItem,
  type RequestView,
  type RequestSummary,
  type CommentView,
  type CreateRequestInput,
  type TransitionInput,
} from './request.service';
export {
  createIncidentFromReport,
  listIncidentsPage,
  getIncident,
  updateIncidentFields,
  assertIncidentVisible,
  assignIncident,
  resolveIncident,
  closeIncident,
  reopenIncident,
  setIncidentMajor,
  addIncidentComment,
  listIncidentComments,
  getIncidentHistory,
  derivePriority,
  type IncidentView,
  type IncidentSummary,
  type IncidentCommentView,
  type IncidentHistoryEntry,
  type CreateIncidentInput,
  type UpdateIncidentInput,
} from './incident.service';
export {
  createTaskOnParent,
  listParentTasks,
  listMyTasksPage,
  getTask,
  updateTaskFields,
  assignTask,
  transitionTask,
  assertTaskVisible,
  type TaskView,
  type CreateTaskInput,
  type UpdateTaskInput,
  type TransitionTaskInput,
} from './task.service';
export {
  startClock,
  stopClock,
  pauseClockIfPolicy,
  resumeClock,
  deriveState,
  describeClock,
  clockViewsFor,
  clockViewFor,
  type ClockEntityType,
  type SlaClockView,
} from './sla-clock.service';
export { runSlaSweep, type SweepResult } from './sla-sweep.service';
export {
  instantiateWorkflowForRequest,
  cancelWorkflowForRequest,
  listPendingApprovals,
  getRequestApprovals,
  decideApprovalStep,
  reassignApprovalStep,
  listTemplates,
  createTemplate,
  type ApprovalWorkflowView,
  type ApprovalStepView,
  type ApprovalTemplateView,
  type DecideResult,
} from './approval.service';
export { startSlaSweepScheduler, type SlaSweepScheduler } from './sla-sweep-scheduler';
export { drainOutbox, type DrainResult } from './notification.service';
export { resolveNotificationTemplate, type RenderedMessage } from './notification-templates';
export { startNotificationScheduler, type NotificationScheduler } from './notification-scheduler';
// Provider delivery webhooks (`docs/29` N8): delivery, bounce and complaint update the
// notification record. Registered explicitly by each entrypoint, not on import.
export {
  PROVIDER_NOTIFICATION_EVENT,
  registerNotificationProviderHandlers,
} from './notification-provider-webhooks';
export {
  listMyPreferences,
  updateMyPreferences,
  listMyNotifications,
  readNotification,
  readAllNotifications,
  type PreferenceView,
  type PreferenceInput,
  type NotificationView,
  type NotificationPage,
} from './notification-centre.service';
export {
  getEventDefinition,
  isMandatory,
  listEventDefinitions,
  NOTIFICATION_CHANNELS,
  type NotificationClass,
  type NotificationChannel,
} from './notification-events';
export {
  search,
  hrefFor,
  type SearchInput,
  type SearchResult,
  type SearchResultItem,
} from './search.service';
export {
  runReport,
  REPORT_METRICS,
  type ReportInput,
  type ReportResult,
  type ReportMetric,
} from './report.service';
export {
  listCalendars,
  listPolicies,
  getPolicy,
  getClock,
  overrideClock,
  createCalendar,
  updateCalendar,
  createPolicy,
  updatePolicy,
  seedTenantSlaDefaults,
  type CreateCalendarInput,
  type UpdateCalendarInput,
  type CreatePolicyInput,
  type ClockOverrideInput,
} from './sla.service';
export {
  requestExport,
  getExport,
  downloadExport,
  processQueuedExports,
  reportToCsv,
  type ReportExportView,
  type ReportDownloadTarget,
} from './report-export.service';
export { startReportExportScheduler, type ReportExportScheduler } from './report-export-scheduler';
export {
  listArticlesPage,
  getArticle,
  getArticleStats,
  recordArticleFeedback,
  createArticleDraft,
  updateArticleDraft,
  submitArticleForReview,
  rejectArticle,
  publishArticle,
  archiveArticle,
  unarchiveArticle,
  createKnowledgeCategory,
  renameKnowledgeCategory,
  listKnowledgeCategories,
  linkArticleToRecord,
  listRecordKnowledgeLinks,
  resolveArticleScope,
  assertArticleVisible,
  type ArticleView,
  type ArticleListItem,
  type CreateArticleInput,
  type UpdateArticleInput,
} from './kb.service';
export {
  listAssetsPage,
  getAsset,
  getAssetByTag,
  getAssetStats,
  createAssetRecord,
  updateAssetRecord,
  assignAsset,
  returnAsset,
  markAssetInRepair,
  retireAsset,
  disposeAsset,
  listAssetAssignments,
  createAssetTypeDefinition,
  updateAssetTypeDefinition,
  listAssetTypeDefinitions,
  resolveAssetScope,
  assertAssetVisible,
  type AssetView,
  type AssetListItem,
  type CreateAssetInput,
  type UpdateAssetInput,
  type AssignAssetInput,
} from './asset.service';
export {
  listAuditEntries,
  listSecurityAuditEntries,
  getRecordHistory,
  getRecordHistoryForCaller,
  canReadAudit,
  isSecurityAction,
  resolveScopeActorIds,
  SECURITY_ACTION_PREFIXES,
  type AuditEntryView,
  type ListAuditInput,
} from './audit.service';
export {
  requestAuditExport,
  getAuditExport,
  downloadAuditExport,
  renderAuditCsv,
  AUDIT_EXPORT_METRIC,
  type AuditExportFilters,
  type AuditExportView,
} from './audit-export.service';
export {
  SUBSCRIBABLE_EVENTS,
  createWebhookSubscriptionForCaller,
  updateWebhookSubscriptionForCaller,
  listWebhookSubscriptionsForCaller,
  listDeadLettersForCaller,
  retryDeadLetterForCaller,
  buildWebhookPayload,
  fanoutWebhooks,
  deliverPendingWebhooks,
  toDeliveryView,
  type WebhookSubscriptionView,
  type WebhookSubscriptionCreated,
  type WebhookDeliveryView,
  type CreateSubscriptionInput,
  type UpdateSubscriptionInput,
  type FanoutResult,
  type WebhookWorkerOptions,
  type WebhookDeliveryResult,
} from './webhook.service';
export { startWebhookScheduler, type WebhookScheduler } from './webhook-scheduler';
export {
  getIntegrationHealthForCaller,
  type IntegrationHealth,
  type IntegrationKind,
} from './integration-health.service';
export {
  INTEGRATION_CATALOGUE,
  listIntegrationConfigForCaller,
  updateIntegrationConfigForCaller,
  testIntegrationForCaller,
  integrationReliabilityDefaults,
  type IntegrationConfigView,
  type IntegrationCatalogueEntry,
  type UpdateIntegrationConfigInput,
  type IntegrationTestResult,
} from './integration-config.service';
export {
  syncRoster,
  getRosterSyncStatusForCaller,
  triggerRosterSyncForCaller,
  type RosterSyncResult,
  type RosterSyncOutcome,
  type RosterSyncStatus,
  type RosterSyncOptions,
} from './roster-sync.service';
export { startRosterSyncScheduler, type RosterSyncScheduler } from './roster-sync-scheduler';
export {
  registerInboundHandler,
  clearInboundHandlers,
  createInboundEndpointForCaller,
  updateInboundEndpointForCaller,
  listInboundEndpointsForCaller,
  receiveInboundWebhook,
  processInboundWebhookEvents,
  listInboundDeadLettersForCaller,
  retryInboundDeadLetterForCaller,
  toInboundEventView,
  type InboundHandler,
  type ReceiveOutcome,
  type InboundEndpointView,
  type InboundEndpointCreated,
  type InboundEventView,
  type CreateInboundEndpointInput,
  type UpdateInboundEndpointInput,
  type InboundProcessResult,
} from './inbound-webhook.service';
export {
  startInboundWebhookScheduler,
  type InboundWebhookScheduler,
} from './inbound-webhook-scheduler';
export { listOwnSessions, revokeOwnSession, type SessionView } from './auth.service';
export {
  recordRequest,
  recordJobRun,
  renderMetrics,
  resetMetrics,
  routeLabel,
  statusClass,
  LATENCY_BUCKETS,
} from './metrics.service';
export {
  createTeamRecord,
  getTeamMembers,
  addMember,
  removeMember,
  type TeamDetail,
  type TeamMemberView,
} from './teams.service';
export {
  uploadAttachment,
  listAttachments,
  openAttachment,
  type AttachmentView,
  type AttachmentParentType,
  type DownloadTarget,
  type UploadInput,
} from './attachment.service';
// The asynchronous antivirus scan step (`docs/19` §7.2): the worker that makes an uploaded
// file retrievable, and the scheduler that drives it.
export { scanPendingAttachments, type AttachmentScanResult } from './attachment-scan.service';
export {
  startAttachmentScanScheduler,
  type AttachmentScanScheduler,
} from './attachment-scan-scheduler';
