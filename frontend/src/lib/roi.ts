// P6.4 ROI calculator (PRD 11.2). Pure arithmetic over stated assumptions, run in the browser.
// Every output is an illustrative projection using synthetic workload. Nothing here is a saving
// anyone has achieved, and no default is an employer's or customer's number.

export const ROI_LABEL = "Illustrative projection using synthetic workload";
export const ASSUMPTIONS_VERSION = "roi-assumptions-1";

export type RoiInputs = {
  tasksPerMonth: number;
  manualMinutesPerTask: number;
  reviewedMinutesPerTask: number;
  exceptionRatePct: number;
  exceptionMinutes: number;
  hourlyLaborCost: number;
  platformCostPerMonth: number;
  automationCostPerMonth: number;
  aiCostPerTask: number;
};

export type InputKey = keyof RoiInputs;

export const INPUTS: {
  key: InputKey;
  label: string;
  unit: string;
  max: number;
  step: number;
  source: string;
}[] = [
  {
    key: "tasksPerMonth",
    label: "Tasks per month",
    unit: "tasks",
    max: 1_000_000,
    step: 10,
    source: "Assumed workload for a small operations team. Not measured.",
  },
  {
    key: "manualMinutesPerTask",
    label: "Manual minutes per task",
    unit: "minutes",
    max: 600,
    step: 1,
    source: "Assumed: re-keying a record between two systems and checking it. Not timed.",
  },
  {
    key: "reviewedMinutesPerTask",
    label: "Reviewed minutes per task",
    unit: "minutes",
    max: 600,
    step: 1,
    source: "Assumed: a person checks a prepared suggestion instead of re-keying. Not timed.",
  },
  {
    key: "exceptionRatePct",
    label: "Exception rate",
    unit: "%",
    max: 100,
    step: 1,
    source: "Assumed share of tasks that still need full manual handling.",
  },
  {
    key: "exceptionMinutes",
    label: "Minutes per exception",
    unit: "minutes",
    max: 600,
    step: 1,
    source: "Assumed: an exception takes longer than an ordinary manual task.",
  },
  {
    key: "hourlyLaborCost",
    label: "Hourly labor cost",
    unit: "USD per hour",
    max: 10_000,
    step: 1,
    source:
      "Placeholder. Replace with your own loaded cost; this is not a market or employer rate.",
  },
  {
    key: "platformCostPerMonth",
    label: "Platform cost",
    unit: "USD per month",
    max: 10_000_000,
    step: 5,
    source: "Modeled hosting and database cost. The demo itself runs on free tiers.",
  },
  {
    key: "automationCostPerMonth",
    label: "Automation tool cost",
    unit: "USD per month",
    max: 10_000_000,
    step: 5,
    source: "Modeled workflow-tool subscription, for example a Zapier plan. Not a quote.",
  },
  {
    key: "aiCostPerTask",
    label: "AI cost per task",
    unit: "USD per task",
    max: 100,
    step: 0.01,
    source: "Modeled model-call cost. Live AI is not configured, so nothing has been measured.",
  },
];

export const SCENARIOS: Record<"conservative" | "base" | "optimistic", RoiInputs> = {
  conservative: {
    tasksPerMonth: 400,
    manualMinutesPerTask: 12,
    reviewedMinutesPerTask: 7,
    exceptionRatePct: 20,
    exceptionMinutes: 30,
    hourlyLaborCost: 35,
    platformCostPerMonth: 50,
    automationCostPerMonth: 60,
    aiCostPerTask: 0.05,
  },
  base: {
    tasksPerMonth: 400,
    manualMinutesPerTask: 15,
    reviewedMinutesPerTask: 5,
    exceptionRatePct: 10,
    exceptionMinutes: 20,
    hourlyLaborCost: 35,
    platformCostPerMonth: 25,
    automationCostPerMonth: 30,
    aiCostPerTask: 0.02,
  },
  optimistic: {
    tasksPerMonth: 400,
    manualMinutesPerTask: 18,
    reviewedMinutesPerTask: 4,
    exceptionRatePct: 5,
    exceptionMinutes: 15,
    hourlyLaborCost: 35,
    platformCostPerMonth: 25,
    automationCostPerMonth: 30,
    aiCostPerTask: 0.01,
  },
};

export type RoiResult = {
  exceptions: number;
  baselineMinutes: number;
  automatedMinutes: number;
  grossHoursSaved: number;
  laborValue: number;
  modeledAiCost: number;
  totalModeledCost: number;
  netValue: number;
  // Empty when total modeled cost is zero: PRD 11.2 computes ROI only for a positive denominator.
  roi: number | null;
  // Tasks a month at which net value reaches zero. Empty when no volume gets there.
  breakEvenTasks: number | null;
};

export function validate(inputs: RoiInputs): Partial<Record<InputKey, string>> {
  const errors: Partial<Record<InputKey, string>> = {};
  for (const d of INPUTS) {
    const v = inputs[d.key];
    if (typeof v !== "number" || !Number.isFinite(v)) errors[d.key] = "Enter a number.";
    else if (v < 0) errors[d.key] = "Can't be negative.";
    else if (v > d.max) errors[d.key] = `At most ${d.max.toLocaleString("en-US")}.`;
  }
  return errors;
}

// PRD 11.2, line by line. Exceptions are an expected count (tasks x rate), so they can be
// fractional; rounding them would make the output jump as the rate changes.
export function calculate(i: RoiInputs): RoiResult {
  const exceptions = i.tasksPerMonth * (i.exceptionRatePct / 100);
  const baselineMinutes = i.tasksPerMonth * i.manualMinutesPerTask;
  const automatedMinutes =
    i.tasksPerMonth * i.reviewedMinutesPerTask + exceptions * i.exceptionMinutes;
  const grossHoursSaved = Math.max(0, (baselineMinutes - automatedMinutes) / 60);
  const laborValue = grossHoursSaved * i.hourlyLaborCost;
  const modeledAiCost = i.tasksPerMonth * i.aiCostPerTask;
  const totalModeledCost = i.platformCostPerMonth + i.automationCostPerMonth + modeledAiCost;
  const netValue = laborValue - totalModeledCost;
  const roi = totalModeledCost > 0 ? netValue / totalModeledCost : null;
  const minutesSavedPerTask =
    i.manualMinutesPerTask -
    i.reviewedMinutesPerTask -
    (i.exceptionRatePct / 100) * i.exceptionMinutes;
  const valuePerTask = (minutesSavedPerTask / 60) * i.hourlyLaborCost - i.aiCostPerTask;
  const fixed = i.platformCostPerMonth + i.automationCostPerMonth;
  const breakEvenTasks =
    minutesSavedPerTask > 0 && valuePerTask > 0 ? Math.ceil(fixed / valuePerTask) : null;
  return {
    exceptions,
    baselineMinutes,
    automatedMinutes,
    grossHoursSaved,
    laborValue,
    modeledAiCost,
    totalModeledCost,
    netValue,
    roi,
    breakEvenTasks,
  };
}

export type Sensitivity = {
  key: InputKey;
  label: string;
  low: number;
  high: number;
  swing: number;
};

// Which inputs move the result most: each one alone, 20% down and 20% up, the rest held at the
// given values. Sorted by how far net value moves.
export function sensitivity(inputs: RoiInputs, change = 0.2): Sensitivity[] {
  return INPUTS.map((d) => {
    const at = (factor: number) =>
      calculate({ ...inputs, [d.key]: Math.min(d.max, inputs[d.key] * factor) }).netValue;
    const low = at(1 - change);
    const high = at(1 + change);
    return { key: d.key, label: d.label, low, high, swing: Math.abs(high - low) };
  }).sort((a, b) => b.swing - a.swing || a.key.localeCompare(b.key));
}

// Shown to two significant figures: the assumptions don't support more precision than that.
export function rough(value: number): number {
  if (value === 0) return 0;
  const digits = Math.floor(Math.log10(Math.abs(value)));
  const scale = 10 ** Math.max(0, digits - 1);
  return Math.round(value / scale) * scale;
}

export const usd = (v: number) =>
  `${v < 0 ? "-" : ""}$${Math.abs(rough(v)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
