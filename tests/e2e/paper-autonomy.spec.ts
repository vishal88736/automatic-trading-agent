import { expect, test } from "@playwright/test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";

test.skip(
  process.env.KRONO_E2E_AUTONOMY !== "1",
  "Requires disposable PostgreSQL and product service configuration",
);

const exec = promisify(execFile);
const python = ".venv/bin/python";
const readState = `
import json, os, sys
from uuid import UUID
from backend.product.database import DSN_ENV, open_database
from psycopg.rows import dict_row
with open_database(os.environ[DSN_ENV]) as db, db.cursor(row_factory=dict_row) as c:
    ident = UUID(sys.argv[1])
    row = c.execute("""
        SELECT a.status, a.stage, a.last_candle::text AS candle,
            (SELECT count(*) FROM paper_agent_events WHERE agent_id = a.id AND kind = 'DECISION') AS decisions,
            (SELECT count(*) FROM paper_orders WHERE agent_id = a.id AND status = 'FILLED') AS fills,
            (SELECT coalesce(json_agg(id::text), '[]'::json) FROM
                (SELECT id FROM paper_orders WHERE agent_id = a.id AND status = 'FILLED' ORDER BY created_at, id) o
            ) AS fill_ids
        FROM paper_agents a WHERE a.id = %s
    """, (ident,)).fetchone()
    print(json.dumps(row))
`;
interface State {
  status: string;
  stage: string;
  candle: string;
  decisions: number;
  fills: number;
  fill_ids: string[];
}
async function state(agent: string): Promise<State> {
  return JSON.parse((await exec(python, ["-c", readState, agent])).stdout);
}

test("paper agent continues without a browser and survives API and worker restarts", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120000);
  const children = new Set<ChildProcess>();
  const endpoint = process.env.KRONO_E2E_PRODUCT_API_URL!;
  const origin = String(Date.now() / 1000);
  function launch(args: string[]) {
    const child = spawn(python, args, {
      env: {
        ...process.env,
        TERMINAL_TEST_RUN: "1",
        KRONO_TEST_MARKET_ORIGIN: origin,
      },
      stdio: "inherit",
    });
    children.add(child);
    return child;
  }
  async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
    if (child.exitCode === null && child.signalCode === null) {
      const exiting = once(child, "exit");
      child.kill(signal);
      await exiting;
    }
    children.delete(child);
  }
  async function api() {
    const port = new URL(endpoint).port;
    const child = launch([
      "-m",
      "uvicorn",
      "tests.e2e.product_api:application",
      "--factory",
      "--host",
      "127.0.0.1",
      "--port",
      port,
    ]);
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(endpoint + "/platform/paper-account")).status;
          } catch {
            return 0;
          }
        },
        { timeout: 15000 },
      )
      .toBe(401);
    return child;
  }
  async function browserSession() {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await page.goto("/#/strategies");
    await page
      .getByLabel("Email", { exact: true })
      .fill("lifecycle@fixture.test");
    await page.getByLabel("Password", { exact: true }).fill("fixture");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Strategies", exact: true }),
    ).toBeVisible();
    return { page, context };
  }

  try {
    let service = await api();
    let worker = launch(["-m", "tests.e2e.paper_worker_fixture"]);
    const { page, context } = await browserSession();
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link")).toHaveCount(12);
    await page.setViewportSize({ width: 320, height: 850 });
    await expect(nav).toBeHidden();
    const menu = page.getByRole("button", { name: "Open navigation" });
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await nav.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(320);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(
      page.getByRole("heading", { name: "Virtual balance" }),
    ).toBeVisible();
    await nav.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Recent paper orders" }),
    ).toBeVisible();
    await page.goto("/#/markets");
    await page
      .getByRole("button", { name: "Generate insight for BTC" })
      .click();
    await expect(
      page.getByText("This snapshot cannot establish future returns."),
    ).toBeVisible();
    await nav.getByRole("link", { name: "Settings", exact: true }).click();
    await page
      .getByRole("link", { name: "My strategies", exact: true })
      .click();
    const editor = page.getByLabel("Strategy JSON");
    await expect(editor).toBeEnabled();
    const draft = JSON.parse(await editor.inputValue());
    const condition = { indicator: "price", operator: "gt", threshold: "1" };
    draft.name = "Durable fixture strategy";
    draft.definition.entry.conditions = [condition];
    draft.definition.exit.conditions = [condition];
    await editor.fill(JSON.stringify(draft));
    await page
      .getByRole("button", { name: "Save strategy", exact: true })
      .click();
    await expect(page.getByText("Saved version 1.")).toBeVisible();
    await page.getByRole("link", { name: "Backtesting", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Strategy", exact: true })
      .selectOption({ label: "Durable fixture strategy · BTC/USD · v1" });
    await page.getByLabel("Start date").fill("2026-01-15");
    await page.getByLabel("End date (exclusive)").fill("2026-01-22");
    await page.getByRole("button", { name: "Run backtest" }).click();
    await page
      .getByRole("link", { name: "Use report for a paper agent" })
      .click();
    await expect(page.getByLabel("Backtest report ID")).not.toHaveValue("");
    await nav
      .getByRole("link", { name: "AI Strategy Builder", exact: true })
      .click();
    const chat = page.getByRole("region", { name: "Strategy chat" });
    await chat
      .getByLabel("Trading prompt")
      .fill(
        "Run a paper agent. Enter and exit when BTC price is above 1 USD, with 2% of cash and a 4% stop loss.",
      );
    await chat.getByRole("button", { name: "Send prompt" }).click();
    await page.getByRole("button", { name: "Run as paper agent" }).click();
    await chat.getByLabel("Agent name").fill("Independent fixture agent");
    await chat.getByLabel("Evaluation interval (seconds)").fill("10");
    const startResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/platform/strategy-authoring/start-agent") &&
        response.request().method() === "POST",
    );
    await chat
      .getByRole("button", { name: "Start paper agent", exact: true })
      .click();
    const started = await startResponse;
    expect(started.status()).toBe(201);
    const { id, strategy } = await started.json();
    expect(strategy.document.name).toBe("Fixture price draft");
    await chat.getByRole("link", { name: "View paper agent" }).click();
    await expect(
      page.locator('.kx-agent-item[aria-pressed="true"]'),
    ).toHaveAttribute("data-agent-id", id);
    await context.close();
    expect(browser.contexts()).toHaveLength(0);

    const disconnected = await state(id);
    await expect
      .poll(async () => (await state(id)).fills, { timeout: 22000 })
      .toBeGreaterThan(disconnected.fills);
    const first = await state(id);
    await stop(service);
    // Keep the private product API offline while the worker processes the next event.
    await expect
      .poll(async () => (await state(id)).decisions, { timeout: 22000 })
      .toBeGreaterThan(first.decisions);
    service = await api();

    const beforeCrash = await state(id);
    await stop(worker, "SIGKILL");
    worker = launch(["-m", "tests.e2e.paper_worker_fixture"]);
    await expect
      .poll(async () => (await state(id)).decisions, { timeout: 22000 })
      .toBeGreaterThan(beforeCrash.decisions);
    const afterCrash = await state(id);
    expect(afterCrash.candle).not.toBe(beforeCrash.candle);
    expect(afterCrash.fill_ids.slice(0, beforeCrash.fills)).toEqual(
      beforeCrash.fill_ids,
    );
    expect(new Set(afterCrash.fill_ids).size).toBe(afterCrash.fills);

    const reopened = await browserSession();
    const eventStream = reopened.page.waitForResponse((response) =>
      response.url().endsWith(`/paper-agents/${id}/stream`),
    );
    await reopened.page
      .getByRole("link", { name: "My Agents", exact: true })
      .click();
    await expect(
      reopened.page.getByRole("heading", { name: /Independent fixture agent/ }),
    ).toBeVisible();
    await expect(
      reopened.page.getByText("Live activity", { exact: true }),
    ).toBeVisible();
    expect((await eventStream).headers()["content-type"]).toContain(
      "text/event-stream",
    );
    await expect(reopened.page.getByText(/Replay approved/)).toBeVisible();
    await reopened.page
      .getByRole("link", { name: "Overview", exact: true })
      .click();
    const orders = reopened.page
      .getByRole("region", { name: "Recent paper orders" })
      .getByRole("table");
    await expect(
      orders.getByRole("cell", { name: "Agent", exact: true }).first(),
    ).toBeVisible();
    await reopened.page
      .getByRole("link", { name: "My Agents", exact: true })
      .click();

    await reopened.page
      .getByRole("button", { name: "Stop agent", exact: true })
      .click();
    await expect.poll(async () => (await state(id)).status).toBe("STOPPED");
    const stopped = await state(id);
    await reopened.context.close();
    await new Promise((resolve) => setTimeout(resolve, 10500));
    expect(await state(id)).toEqual(stopped);
  } finally {
    await Promise.all([...children].map((child) => stop(child)));
  }
});
