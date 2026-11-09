// P6.1 metric glossary (PRD 11, docs/design/METRICS.md). One written formula per metric. The SQL
// in backend/src/repo/analytics.ts implements each one, and tests recompute them from the rows.

export const METRICS_VERSION = "metrics-1";

// PRD 11.2: every metric carries one of these, and the UI explains each.
export type Provenance = "SYNTHETIC" | "MEASURED_DEMO" | "ESTIMATED" | "UNKNOWN";

export const PROVENANCE_TEXT: Record<Provenance, string> = {
  SYNTHETIC: "Counted from fictional records in this demo. Exact, but the records are made up.",
  MEASURED_DEMO: "Measured from actions taken in this demo workspace. Real timing, tiny sample.",
  ESTIMATED: "Calculated from stated assumptions, not observed. Change the assumptions to test it.",
  UNKNOWN: "No data source exists for this yet, so no value is shown.",
};

export type Unit = "count" | "days" | "hours" | "minutes" | "ratio" | "usd";

export type MetricDefinition = {
  label: string;
  unit: Unit;
  provenance: Provenance;
  formula: string;
};

export const SNAPSHOT_KEYS = [
  "open_cases",
  "completed_cases",
  "review_queue",
  "open_findings",
  "automation_failed",
] as const;
export type SnapshotKey = (typeof SNAPSHOT_KEYS)[number];

export const OPEN_STATUSES = ["Intake", "Needs Review", "Ready"] as const;
export const DONE_STATUSES = ["Approved", "Closed"] as const;
export const FUNNEL = ["Draft", "Intake", "Needs Review", "Ready", "Approved", "Closed"] as const;
export const UNRESOLVED_FINDING = "status NOT IN ('Resolved','Dismissed')";

// Assumption only, shown with the ESTIMATED label: how many manual steps one automated notice
// stands in for (open the record, copy the details, send the message). Not measured.
export const ASSUMED_STEPS_PER_NOTICE = 3;

export const GLOSSARY: Record<string, MetricDefinition> = {
  open_cases: {
    label: "Open cases",
    unit: "count",
    provenance: "SYNTHETIC",
    formula: "Cases whose status is Intake, Needs Review or Ready.",
  },
  completed_cases: {
    label: "Completed cases",
    unit: "count",
    provenance: "SYNTHETIC",
    formula: "Cases whose status is Approved or Closed.",
  },
  draft_cases: {
    label: "Drafts",
    unit: "count",
    provenance: "SYNTHETIC",
    formula: "Cases whose status is Draft. Not in the funnel's denominator.",
  },
  review_queue: {
    label: "Waiting for review",
    unit: "count",
    provenance: "SYNTHETIC",
    formula: "Cases whose status is Needs Review.",
  },
  review_age_max: {
    label: "Oldest case in review",
    unit: "days",
    provenance: "SYNTHETIC",
    formula:
      "Whole days since creation of the oldest Needs Review case. Cases keep no time of entry to a status, so this is age since creation.",
  },
  overdue_open: {
    label: "Overdue open cases",
    unit: "count",
    provenance: "SYNTHETIC",
    formula: "Open cases whose due date is in the past.",
  },
  open_findings: {
    label: "Exception queue",
    unit: "count",
    provenance: "SYNTHETIC",
    formula: "Reconciliation findings not Resolved and not Dismissed.",
  },
  last_sync_age: {
    label: "Since last successful sync",
    unit: "hours",
    provenance: "SYNTHETIC",
    formula:
      "Hours since the latest last_success_at across this scope's source connections. Empty when no sync has succeeded.",
  },
  completion_rate: {
    label: "Completion rate",
    unit: "ratio",
    provenance: "SYNTHETIC",
    formula: "(Approved + Closed) / all cases except Draft. Empty when there are none.",
  },
  findings_resolved: {
    label: "Resolved findings",
    unit: "count",
    provenance: "SYNTHETIC",
    formula: "Findings with status Resolved.",
  },
  findings_dismissed: {
    label: "Dismissed findings",
    unit: "count",
    provenance: "SYNTHETIC",
    formula: "Findings with status Dismissed.",
  },
  oldest_unresolved: {
    label: "Oldest unresolved finding",
    unit: "days",
    provenance: "SYNTHETIC",
    formula: "Whole days since detected_at of the oldest unresolved finding.",
  },
  documents: {
    label: "Documents attached",
    unit: "count",
    provenance: "SYNTHETIC",
    formula: "Fixture documents attached to cases in scope.",
  },
  ai_reviews: {
    label: "Reviews run",
    unit: "count",
    provenance: "SYNTHETIC",
    formula: "AI review rows in scope, any status.",
  },
  ai_abstained: {
    label: "Abstentions",
    unit: "count",
    provenance: "SYNTHETIC",
    formula: "Reviews with an abstain reason.",
  },
  ai_decision_minutes: {
    label: "Median time to a review decision",
    unit: "minutes",
    provenance: "MEASURED_DEMO",
    formula:
      "Median minutes from requested_at to decided_at over decided reviews in your own workspace. Empty until you decide one.",
  },
  ai_live_cost: {
    label: "Live provider cost",
    unit: "usd",
    provenance: "UNKNOWN",
    formula:
      "Sum of estimated live-model cost in ai_usage. Live AI is Pending Owner Credentials, so no value exists. Not zero.",
  },
  automation_retries: {
    label: "Retries",
    unit: "count",
    provenance: "SYNTHETIC",
    formula: "Sum over events of attempts beyond the first.",
  },
  automation_failed: {
    label: "Dead letters",
    unit: "count",
    provenance: "SYNTHETIC",
    formula: "Events whose dispatch ended in dead_letter (label Failed).",
  },
  manual_steps_avoided: {
    label: "Manual steps avoided (estimate)",
    unit: "count",
    provenance: "ESTIMATED",
    formula: `(Accepted + Confirmed + Simulated events) x ${ASSUMED_STEPS_PER_NOTICE} assumed steps per notice. An assumption, not a measurement.`,
  },
};

// P5.5 fixture evaluation, copied from docs/evidence/P5.5/eval-report.json. A unit test holds the
// two together. These are fixture results, never live-model accuracy.
export const FIXTURE_EVALUATION = {
  disclosure:
    "Fixture results from a labeled-line extractor run through the real validation path. Not live-model accuracy. No language model was called.",
  model: "fixture:labeled-line-extractor-v1",
  evalVersion: "eval-v1",
  date: "2026-11-09T19:58:52.062Z",
  documents: 40,
  standardAccuracy: 1,
  messyWithTextAccuracy: 0.979,
  schemaValid: 1,
  unauthorizedWrites: 0,
  adversarialOverrides: 0,
  estimatedCostUsd: 0,
  report: "docs/evidence/P5.5/eval-report.md",
} as const;
