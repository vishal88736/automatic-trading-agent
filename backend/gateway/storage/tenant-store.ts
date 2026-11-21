import { randomUUID } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { conflict, denied } from "../domain/errors.js";
import type { Principal, RecordItem } from "../domain/schemas.js";

export interface Write {
  kind: string;
  id: string;
  expectedVersion: number;
  data: unknown;
}
export interface Page<T> {
  items: RecordItem<T>[];
  cursor?: string;
}
export interface TenantStore {
  get<T>(
    scope: Principal,
    kind: string,
    id: string,
  ): Promise<RecordItem<T> | undefined>;
  list<T>(
    scope: Principal,
    kind: string,
    limit?: number,
    cursor?: string,
  ): Promise<Page<T>>;
  commit(
    scope: Principal,
    writes: Write[],
    event: string,
    details?: unknown,
  ): Promise<void>;
}
const segment = (s: string) => {
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(s))
    throw denied("Invalid resource identifier");
  return s;
};
export const tenantKey = (scope: Principal) =>
  `TENANT#${segment(scope.userId)}`;
const sortKey = (kind: string, id: string) => `${segment(kind)}#${segment(id)}`;
export const runtimeKey = (scope: Principal, agentId: string) =>
  `${tenantKey(scope)}#AGENT#${segment(agentId)}`;
function parseCursor(cursor: string | undefined, pk: string, prefix: string) {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 2048) throw Error();
    const key = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      Object.keys(key).sort().join() !== "pk,sk" ||
      key.pk !== pk ||
      typeof key.sk !== "string" ||
      !key.sk.startsWith(prefix)
    )
      throw Error();
    return key as { pk: string; sk: string };
  } catch {
    throw denied("Invalid pagination cursor");
  }
}
export class DynamoTenantStore implements TenantStore {
  constructor(
    private db: DynamoDBDocumentClient,
    private table: string,
  ) {}
  async get<T>(scope: Principal, kind: string, id: string) {
    const r = await this.db.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: tenantKey(scope), sk: sortKey(kind, id) },
        ConsistentRead: true,
      }),
    );
    return r.Item as RecordItem<T> | undefined;
  }
  async list<T>(
    scope: Principal,
    kind: string,
    limit = 50,
    cursor?: string,
  ): Promise<Page<T>> {
    const pk = tenantKey(scope),
      prefix = `${segment(kind)}#`;
    const r = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: { ":pk": pk, ":sk": prefix },
        Limit: Math.min(100, Math.max(1, limit)),
        ExclusiveStartKey: parseCursor(cursor, pk, prefix),
        ConsistentRead: true,
      }),
    );
    return {
      items: (r.Items as RecordItem<T>[]) ?? [],
      cursor: r.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(r.LastEvaluatedKey)).toString("base64url")
        : undefined,
    };
  }
  async commit(
    scope: Principal,
    writes: Write[],
    event: string,
    details: unknown = {},
  ) {
    const pk = tenantKey(scope),
      at = new Date().toISOString();
    if (
      !writes.length ||
      writes.length > 20 ||
      new Set(writes.map((w) => sortKey(w.kind, w.id))).size !== writes.length
    )
      throw Error("Invalid transaction");
    const operations = writes.flatMap((w) => {
      const item = {
        pk,
        sk: sortKey(w.kind, w.id),
        id: w.id,
        version: w.expectedVersion + 1,
        data: w.data,
        updatedAt: at,
        ...(typeof (w.data as { expiresAt?: unknown })?.expiresAt === "number"
          ? { expiresAt: (w.data as { expiresAt: number }).expiresAt }
          : {}),
      };
      if (Buffer.byteLength(JSON.stringify(item)) > 200_000)
        throw denied("Resource exceeds storage limit");
      return [
        {
          Put: {
            TableName: this.table,
            Item: item,
            ConditionExpression:
              w.expectedVersion === 0 ? "attribute_not_exists(pk)" : "#v = :v",
            ...(w.expectedVersion === 0
              ? {}
              : {
                  ExpressionAttributeNames: { "#v": "version" },
                  ExpressionAttributeValues: { ":v": w.expectedVersion },
                }),
          },
        },
        {
          Put: {
            TableName: this.table,
            Item: {
              ...item,
              sk: `VERSION#${sortKey(w.kind, w.id)}#${String(item.version).padStart(10, "0")}`,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ];
    });
    const id = `${at}:${randomUUID()}`;
    operations.push({
      Put: {
        TableName: this.table,
        Item: {
          pk,
          sk: `AUDIT#${id}`,
          id,
          version: 1,
          updatedAt: at,
          data: { event, details, actorId: scope.userId, at },
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });
    try {
      await this.db.send(
        new TransactWriteCommand({ TransactItems: operations }),
      );
    } catch (e) {
      if (
        (e as Error).name === "TransactionCanceledException" &&
        (
          e as { CancellationReasons?: { Code?: string }[] }
        ).CancellationReasons?.some((r) => r.Code === "ConditionalCheckFailed")
      )
        throw conflict();
      throw e;
    }
  }
}

/** Explicit test/local-fixture store; production startup never selects it. */
export class MemoryTenantStore implements TenantStore {
  private rows = new Map<string, RecordItem>();
  async get<T>(p: Principal, k: string, id: string) {
    return structuredClone(
      this.rows.get(`${tenantKey(p)}|${sortKey(k, id)}`),
    ) as RecordItem<T> | undefined;
  }
  async list<T>(
    p: Principal,
    k: string,
    limit = 50,
    cursor?: string,
  ): Promise<Page<T>> {
    const pk = tenantKey(p),
      prefix = `${segment(k)}#`,
      start = parseCursor(cursor, pk, prefix)?.sk ?? "";
    const items = [...this.rows]
      .filter(
        ([key]) =>
          key.startsWith(`${pk}|${prefix}`) && key.split("|")[1] > start,
      )
      .sort(([a], [b]) => a.localeCompare(b));
    const selected = items.slice(0, Math.min(limit, 100));
    return {
      items: structuredClone(selected.map(([, v]) => v)) as RecordItem<T>[],
      cursor:
        items.length > selected.length
          ? Buffer.from(
              JSON.stringify({ pk, sk: selected.at(-1)![0].split("|")[1] }),
            ).toString("base64url")
          : undefined,
    };
  }
  async commit(
    p: Principal,
    writes: Write[],
    event: string,
    details: unknown = {},
  ) {
    const pk = tenantKey(p),
      at = new Date().toISOString();
    const keys = writes.map((w) => `${pk}|${sortKey(w.kind, w.id)}`);
    if (new Set(keys).size !== keys.length) throw conflict();
    for (let i = 0; i < writes.length; i++)
      if ((this.rows.get(keys[i])?.version ?? 0) !== writes[i].expectedVersion)
        throw conflict();
    for (let i = 0; i < writes.length; i++) {
      const w = writes[i],
        row = {
          id: w.id,
          version: w.expectedVersion + 1,
          data: structuredClone(w.data),
          updatedAt: at,
        };
      this.rows.set(keys[i], row);
      this.rows.set(
        `${pk}|VERSION#${sortKey(w.kind, w.id)}#${String(row.version).padStart(10, "0")}`,
        row,
      );
    }
    const id = `${at}:${randomUUID()}`;
    this.rows.set(`${pk}|AUDIT#${id}`, {
      id,
      version: 1,
      updatedAt: at,
      data: { event, details, actorId: p.userId, at },
    });
  }
}
