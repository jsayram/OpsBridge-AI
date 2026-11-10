// Pure mapping from source payloads to the fields OpsBridge keeps. Allowlists only: an unknown
// field is dropped and counted, and a field that looks like it is trying to carry authority
// rejects the whole record. No value import from another project file, because the seed
// generator runs this file under plain Node.

export type CrmOrganization = {
  name: string;
  crmType: string;
  accountNumber: string | null;
};
export type ErpCustomer = {
  name: string;
  entityId: string;
  stage: "LEAD" | "PROSPECT" | "CUSTOMER";
  subsidiary: string | null;
  parent: string | null;
  accountNumber: string | null;
  crmAccountId: string | null;
  inactive: boolean;
};
export type ErpInvoice = {
  tranNumber: string;
  billToExternalId: string;
  amount: string;
  currency: string;
  tranDate: string;
  status: "Open" | "Paid Partially" | "Paid In Full";
};
export type InventoryFact = {
  itemCode: string;
  quantity: string;
  unit: string;
  location: string | null;
  version: number;
};

export type Stream = "organization" | "customer" | "invoice" | "inventory_snapshot";

export type Mapped<T> = {
  externalId: string;
  externalVersion: string;
  sourceModifiedAt: string;
  data: T;
  unknownFields: number;
};
export type Rejected = { externalId: string; reason: string };
export type MapResult<T> = { ok: true; value: Mapped<T> } | { ok: false; rejected: Rejected };

// Field names no CRM, ERP or inventory record has any business carrying into this system. Their
// presence means the payload is wrong or hostile, so the record stops here.
const PRIVILEGED =
  /^(workspace(_?id)?|canonical(_?id)?|tenant(_?id)?|actor(_?id)?|owner(_?id)?|role|roles|is_?admin|admin|permissions?|password|passwd|secret|client_?secret|token|access_?token|refresh_?token|api_?key|authorization|ssn)$/i;

const EXTERNAL_ID = /^[\w.:-]{1,120}$/;

const reject = (externalId: unknown, reason: string): { ok: false; rejected: Rejected } => ({
  ok: false,
  rejected: { externalId: typeof externalId === "string" ? externalId.slice(0, 120) : "", reason },
});

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() && value.length <= max && !value.includes("\u0000")
    ? value.trim()
    : null;

const optionalText = (value: unknown, max: number): string | null | undefined =>
  value === null || value === undefined ? null : (text(value, max) ?? undefined);

const instant = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
};

function inspect(raw: unknown, allowed: ReadonlySet<string>) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  let unknownFields = 0;
  for (const key of Object.keys(record)) {
    if (PRIVILEGED.test(key)) return { record, unknownFields, privileged: true };
    if (!allowed.has(key)) unknownFields++;
  }
  return { record, unknownFields, privileged: false };
}

const CRM_FIELDS = new Set([
  "attributes",
  "Id",
  "Name",
  "Type",
  "AccountNumber",
  "LastModifiedDate",
]);

export function mapCrmOrganization(raw: unknown): MapResult<CrmOrganization> {
  const seen = inspect(raw, CRM_FIELDS);
  if (!seen) return reject("", "not_an_object");
  const r = seen.record;
  if (seen.privileged) return reject(r.Id, "privileged_field");
  const id = text(r.Id, 120);
  const name = text(r.Name, 200);
  const modified = instant(r.LastModifiedDate);
  const accountNumber = optionalText(r.AccountNumber, 40);
  if (!id || !EXTERNAL_ID.test(id)) return reject(r.Id, "bad_external_id");
  if (!name || !modified || accountNumber === undefined) return reject(id, "invalid_field");
  return {
    ok: true,
    value: {
      externalId: id,
      externalVersion: modified,
      sourceModifiedAt: modified,
      unknownFields: seen.unknownFields,
      data: { name, crmType: text(r.Type, 40) ?? "Unknown", accountNumber },
    },
  };
}

const ERP_CUSTOMER_FIELDS = new Set([
  "links",
  "id",
  "entityid",
  "companyname",
  "isperson",
  "stage",
  "subsidiary",
  "parent",
  "accountnumber",
  "externalid",
  "custentity_ob_crm_account_id",
  "lastmodifieddate",
  "isinactive",
]);

export function mapErpCustomer(raw: unknown): MapResult<ErpCustomer> {
  const seen = inspect(raw, ERP_CUSTOMER_FIELDS);
  if (!seen) return reject("", "not_an_object");
  const r = seen.record;
  if (seen.privileged) return reject(r.id, "privileged_field");
  const id = text(r.id, 120);
  const name = text(r.companyname, 200);
  const entityId = text(r.entityid, 80);
  const modified = instant(r.lastmodifieddate);
  const stage = r.stage;
  if (!id || !EXTERNAL_ID.test(id)) return reject(r.id, "bad_external_id");
  if (stage !== "LEAD" && stage !== "PROSPECT" && stage !== "CUSTOMER") {
    return reject(id, "invalid_field");
  }
  if (!name || !entityId || !modified) return reject(id, "invalid_field");
  const subsidiary = optionalText(r.subsidiary, 40);
  const parent = optionalText(r.parent, 120);
  const accountNumber = optionalText(r.accountnumber, 40);
  const crmAccountId = optionalText(r.custentity_ob_crm_account_id, 120);
  if ([subsidiary, parent, accountNumber, crmAccountId].includes(undefined)) {
    return reject(id, "invalid_field");
  }
  return {
    ok: true,
    value: {
      externalId: id,
      externalVersion: modified,
      sourceModifiedAt: modified,
      unknownFields: seen.unknownFields,
      data: {
        name,
        entityId,
        stage,
        subsidiary: subsidiary ?? null,
        parent: parent ?? null,
        accountNumber: accountNumber ?? null,
        crmAccountId: crmAccountId ?? null,
        inactive: r.isinactive === "T",
      },
    },
  };
}

const ERP_INVOICE_FIELDS = new Set([
  "links",
  "id",
  "tranid",
  "entity",
  "foreigntotal",
  "currency",
  "trandate",
  "status",
  "lastmodifieddate",
]);
const INVOICE_STATUS = { A: "Open", B: "Paid Partially", C: "Paid In Full" } as const;
const MONEY = /^-?\d{1,10}(\.\d{1,2})?$/;

export function mapErpInvoice(raw: unknown): MapResult<ErpInvoice> {
  const seen = inspect(raw, ERP_INVOICE_FIELDS);
  if (!seen) return reject("", "not_an_object");
  const r = seen.record;
  if (seen.privileged) return reject(r.id, "privileged_field");
  const id = text(r.id, 120);
  const tranNumber = text(r.tranid, 60);
  const billTo = text(r.entity, 120);
  const modified = instant(r.lastmodifieddate);
  const tranDate = typeof r.trandate === "string" ? r.trandate : "";
  const status = INVOICE_STATUS[r.status as keyof typeof INVOICE_STATUS];
  if (!id || !EXTERNAL_ID.test(id)) return reject(r.id, "bad_external_id");
  if (
    !tranNumber ||
    !billTo ||
    !modified ||
    !status ||
    typeof r.foreigntotal !== "string" ||
    !MONEY.test(r.foreigntotal) ||
    typeof r.currency !== "string" ||
    !/^[A-Z]{3}$/.test(r.currency) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(tranDate) ||
    Number.isNaN(Date.parse(tranDate))
  ) {
    return reject(id, "invalid_field");
  }
  return {
    ok: true,
    value: {
      externalId: id,
      externalVersion: modified,
      sourceModifiedAt: modified,
      unknownFields: seen.unknownFields,
      data: {
        tranNumber,
        billToExternalId: billTo,
        amount: r.foreigntotal,
        currency: r.currency,
        tranDate,
        status,
      },
    },
  };
}

const INVENTORY_FIELDS = new Set([
  "externalId",
  "itemCode",
  "quantity",
  "unit",
  "location",
  "version",
  "sourceTimestamp",
]);
const QUANTITY = /^\d{1,11}(\.\d{1,3})?$/;

export function mapInventoryFact(raw: unknown): MapResult<InventoryFact> {
  const seen = inspect(raw, INVENTORY_FIELDS);
  if (!seen) return reject("", "not_an_object");
  const r = seen.record;
  if (seen.privileged) return reject(r.externalId, "privileged_field");
  const id = text(r.externalId, 120);
  const itemCode = text(r.itemCode, 40);
  const unit = text(r.unit, 20);
  const modified = instant(r.sourceTimestamp);
  const location = optionalText(r.location, 80);
  const version = r.version;
  if (!id || !EXTERNAL_ID.test(id)) return reject(r.externalId, "bad_external_id");
  if (
    !itemCode ||
    !unit ||
    !modified ||
    location === undefined ||
    typeof r.quantity !== "string" ||
    !QUANTITY.test(r.quantity) ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > 2_147_483_647
  ) {
    return reject(id, "invalid_field");
  }
  return {
    ok: true,
    value: {
      externalId: id,
      externalVersion: String(version),
      sourceModifiedAt: modified,
      unknownFields: seen.unknownFields,
      data: { itemCode, quantity: r.quantity, unit, location: location ?? null, version },
    },
  };
}
