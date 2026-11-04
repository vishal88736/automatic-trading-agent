import { AEGIS_VIEWS, routeHash } from "./aegis/navigation";
import type { Workspace } from "./aegis/navigation";
import type { Page } from "./types";

export const walletReviewKey = "aegis.assistant-wallet-review.v1";
export const walletReviewEvent = "aegis-assistant-wallet-review";
const pages = new Set<string>([...AEGIS_VIEWS, "news"]);

export type WalletReview = {
  action: "deposit" | "withdraw" | "pause" | "resume";
  network: "testnet" | "mainnet";
  amount?: string | null;
};

function walletReview(value: unknown): WalletReview | null {
  if (!value || typeof value !== "object") return null;
  const request = value as WalletReview;
  if (
    !["deposit", "withdraw", "pause", "resume"].includes(request.action) ||
    !["testnet", "mainnet"].includes(request.network) ||
    (request.amount != null &&
      (typeof request.amount !== "string" ||
        !/^\d+(?:\.\d+)?$/.test(request.amount) ||
        !(Number(request.amount) > 0) ||
        Number(request.amount) > 1e12))
  )
    return null;
  return {
    action: request.action,
    network: request.network,
    amount: request.amount,
  };
}

export function consumeWalletReview(): WalletReview | null {
  const raw = sessionStorage.getItem(walletReviewKey);
  sessionStorage.removeItem(walletReviewKey);
  try {
    return walletReview(JSON.parse(raw || "null"));
  } catch {
    return null;
  }
}

/** Only named tool results can request these effects; no URL or script is evaluated. */
export function applyAssistantAction(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const action = value as Record<string, unknown>;
  if (action.type === "navigate") {
    if (
      !["aegis", "research", "platform"].includes(String(action.workspace)) ||
      !pages.has(String(action.page)) ||
      (action.workspace === "aegis" && action.page === "news")
    )
      return false;
    window.location.hash = routeHash(
      action.workspace as Workspace,
      action.page as Page,
    );
    return true;
  }
  if (action.type === "wallet_review") {
    const review = walletReview(action);
    if (!review) return false;
    sessionStorage.setItem(walletReviewKey, JSON.stringify(review));
    window.location.hash = routeHash("aegis", "wallet");
    window.dispatchEvent(new Event(walletReviewEvent));
    return true;
  }
  if (
    action.type === "download" &&
    ["aegis-trade-history.json", "research-trade-history.json"].includes(
      String(action.filename),
    ) &&
    action.data &&
    typeof action.data === "object"
  ) {
    const blob = new Blob([JSON.stringify(action.data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = String(action.filename);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  return false;
}
