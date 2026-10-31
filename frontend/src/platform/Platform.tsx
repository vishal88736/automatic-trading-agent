import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Cloud,
  Cpu,
  Fingerprint,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MessageSquarePlus,
  Pause,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import { JsonDetails, money, timestamp } from "../ui";
import { KronoMark } from "../brand";
import { platform, type AgentRow, type Preview, type Runtime } from "./client";
import "./platform.css";

type Message = {
  role: "user" | "assistant";
  text: string;
  tools?: Array<{ name: string; result: Record<string, unknown> }>;
};
function Auth({ done }: { done: () => void }) {
  const [mode, setMode] = useState("login"),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState(""),
    [code, setCode] = useState(""),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState("");
  return (
    <div className="platform-auth">
      <div className="platform-auth-story">
        <KronoMark />
        <span className="eyebrow">KRONO / AGENT OPERATING PLATFORM</span>
        <h2>
          Your edge.
          <br />
          Your agents.
          <br />
          <em>Your control.</em>
        </h2>
        <p>
          Build a trading operation through conversation. Every agent has its
          own runtime, permissions and auditable decisions.
        </p>
        <div className="platform-assurances">
          <span>
            <Fingerprint size={18} /> Cognito identity
          </span>
          <span>
            <ShieldCheck size={18} /> Isolated workspaces
          </span>
          <span>
            <Cloud size={18} /> AWS infrastructure
          </span>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPending(true);
          setError("");
          void (async () => {
            try {
              if (mode === "login") {
                await platform("/auth/login", "POST", { email, password });
                done();
              }
              if (mode === "register") {
                await platform("/auth/register", "POST", {
                  email,
                  password,
                  displayName: name,
                });
                setMode("verify");
                setNotice("Check your email for a verification code.");
              }
              if (mode === "verify") {
                await platform("/auth/verify", "POST", { email, code });
                setMode("login");
                setNotice("Email verified. Sign in to your workspace.");
              }
              if (mode === "forgot") {
                await platform("/auth/forgot", "POST", { email });
                setMode("reset");
                setNotice("If eligible, a reset code will arrive by email.");
              }
              if (mode === "reset") {
                await platform("/auth/reset", "POST", {
                  email,
                  code,
                  password,
                });
                setMode("login");
                setNotice("Password updated.");
              }
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setPending(false);
            }
          })();
        }}
      >
        <span className="platform-lock">
          <LockKeyhole size={22} />
        </span>
        <h3>
          {
            (
              {
                login: "Welcome to your workspace",
                register: "Create your KRONO account",
                verify: "Verify your email",
                forgot: "Reset your password",
                reset: "Choose a new password",
              } as Record<string, string>
            )[mode]
          }
        </h3>
        <p className="muted">
          Your identity and agent resources are private to your account.
        </p>
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p className="platform-error" role="alert">
            {error}
          </p>
        )}
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            maxLength={254}
          />
        </label>
        {mode === "register" && (
          <label>
            Display name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
              maxLength={80}
            />
          </label>
        )}
        {["verify", "reset"].includes(mode) && (
          <label>
            Verification code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
          </label>
        )}
        {["login", "register", "reset"].includes(mode) && (
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              minLength={mode === "login" ? 1 : 12}
              maxLength={128}
              required
            />
            {mode !== "login" && (
              <small>
                At least 12 characters, uppercase, lowercase, number and symbol.
              </small>
            )}
          </label>
        )}
        <button className="primary" disabled={pending}>
          {pending ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <ArrowRight size={16} />
          )}{" "}
          {mode === "login"
            ? "Sign in"
            : mode === "register"
              ? "Create account"
              : "Continue"}
        </button>
        <div className="platform-auth-links">
          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
            }}
          >
            {mode === "login" ? "Create an account" : "Back to sign in"}
          </button>
          {mode === "login" && (
            <button type="button" onClick={() => setMode("forgot")}>
              Forgot password?
            </button>
          )}
        </div>
        <small>
          Requires the configured Cognito and AWS control plane. No access keys
          belong in this form.
        </small>
      </form>
    </div>
  );
}

export function PlatformWorkspace() {
  const [session, setSession] = useState<{
      userId: string;
      email: string;
    } | null>(null),
    [checking, setChecking] = useState(true),
    [health, setHealth] = useState<{
      configured: boolean;
      model: string;
      region: string;
      validationMode?: string;
    } | null>(null),
    [agents, setAgents] = useState<AgentRow[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [runtime, setRuntime] = useState<Runtime | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [messages, setMessages] = useState<Message[]>([]),
    [input, setInput] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [sessionId, setSessionId] = useState<string | null>(null),
    [pendingRequest, setPendingRequest] = useState<{
      sessionId: string;
      requestId: string;
    } | null>(null),
    [conversations, setConversations] = useState<
      { id: string; data: { title: string }; updatedAt: string }[]
    >([]),
    [events, setEvents] = useState<unknown[]>([]),
    [tab, setTab] = useState("activity"),
    [profile, setProfile] = useState<{
      version: number;
      data: Record<string, unknown>;
    } | null>(null),
    [profileDraft, setProfileDraft] = useState(""),
    [pendingProfile, setPendingProfile] = useState<{
      actionId: string;
      digest: string;
    } | null>(null),
    [usage, setUsage] = useState<unknown[]>([]),
    [emergency, setEmergency] = useState<{
      emergency: boolean;
      version: number;
    } | null>(null),
    [metrics, setMetrics] = useState<{
      cpuPercent: number | null;
      memoryPercent: number | null;
    } | null>(null),
    [deleteText, setDeleteText] = useState("");
  const bottom = useRef<HTMLDivElement>(null),
    locked = useRef(false),
    tenantRef = useRef<string | null>(null);
  const check = useCallback(async () => {
    setChecking(true);
    try {
      setHealth(await platform("/health"));
      try {
        const next = await platform<{ userId: string; email: string }>(
          "/auth/session",
        );
        if (tenantRef.current !== next.userId) {
          setAgents([]);
          setMessages([]);
          setSessionId(null);
          setProfile(null);
          setProfileDraft("");
          setSelected(null);
          setRuntime(null);
          setPreview(null);
          setEvents([]);
          setUsage([]);
          setPendingProfile(null);
          setEmergency(null);
          setMetrics(null);
          tenantRef.current = next.userId;
          setPendingRequest(null);
          setConversations([]);
        }
        setSession(next);
      } catch {
        setSession(null);
      }
    } catch (e) {
      setHealth(null);
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void check();
  }, [check]);
  const refresh = useCallback(async () => {
    if (!session) return;
    const [a, p, u, emergencyPolicy, history] = await Promise.all([
      platform<{ items: AgentRow[] }>("/agents"),
      platform<{ version: number; data: Record<string, unknown> }>("/profile"),
      platform<{ items: unknown[] }>("/history/USAGE?limit=7"),
      platform<{ emergency: boolean; version: number }>("/emergency"),
      platform<{
        items: { id: string; data: { title: string }; updatedAt: string }[];
      }>("/conversations?limit=100"),
    ]);
    if (tenantRef.current !== session.userId) return;
    setAgents(a.items.filter((r) => r.data.state !== "TERMINATED"));
    setProfile(p);
    setUsage(u.items);
    setEmergency(emergencyPolicy);
    setConversations(
      history.items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
  }, [session]);
  useEffect(() => {
    if (!session) return;
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(
      () => void refresh().catch((e) => setError(e.message)),
      10000,
    );
    return () => clearInterval(timer);
  }, [session, refresh]);
  useEffect(() => {
    if (!session || !selected) return;
    let live = true;
    async function poll() {
      try {
        const r = await platform<{ agent: AgentRow; runtime: Runtime | null }>(
          `/agents/${selected}`,
        );
        if (live) {
          setRuntime(r.runtime);
          setAgents((rows) =>
            rows.map((a) => (a.id === selected ? r.agent : a)),
          );
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selected, session]);
  useEffect(() => {
    if (!session || !selected) return;
    let alive = true;
    const poll = async () => {
      try {
        const [activity, measurements] = await Promise.all([
          platform<{ items: unknown[] }>(`/agents/${selected}/events?limit=20`),
          platform<{ cpuPercent: number | null; memoryPercent: number | null }>(
            `/agents/${selected}/metrics`,
          ),
        ]);
        if (alive) {
          if (tab === "activity") setEvents(activity.items);
          setMetrics(measurements);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [session, selected, tab]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);
  const act = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const send = (text: string) =>
    void act(async () => {
      setInput("");
      setMessages((v) => [...v, { role: "user", text }]);
      let id = sessionId;
      if (!id) {
        const r = await platform<{ id: string }>("/conversations", "POST", {});
        id = r.id;
        setSessionId(id);
      }
      const requestId = crypto.randomUUID();
      setPendingRequest({ sessionId: id, requestId });
      try {
        const r = await platform<{
          response: string;
          status: string;
          tools: Message["tools"];
        }>(`/conversations/${id}/messages`, "POST", {
          message: text,
          requestId,
        });
        setMessages((v) => [
          ...v,
          { role: "assistant", text: r.response, tools: r.tools },
        ]);
        setPendingRequest(null);
      } catch (e) {
        setMessages((v) => [
          ...v,
          {
            role: "assistant",
            text: `Request status is uncertain. It has not been resent. Session ${id}, request ${requestId}. ${(e as Error).message}`,
          },
        ]);
        throw e;
      }
    });
  const current = agents.find((a) => a.id === selected);
  if (checking)
    return (
      <div className="platform-loading">
        <LoaderCircle className="spin" /> Connecting to the AWS control plane…
      </div>
    );
  if (!health)
    return (
      <div className="platform-setup">
        <Cloud size={38} />
        <span className="eyebrow">KRONO 2.0 / AWS SETUP</span>
        <h2>Your agent platform starts here.</h2>
        <p>
          The tenant-aware control plane has not been configured or started. The
          local trading terminal remains available from the navigation.
        </p>
        <pre>
          cp deploy/aws/.env.example deploy/aws/.env
          <br />
          npm run aws:preflight
          <br />
          npm run aws:synth
          <br />
          npm run dev:platform
        </pre>
        <p>
          Set your AWS profile, account and budget in the ignored environment
          file. No cloud agents or Bedrock access are being represented as
          connected.
        </p>
        {error && <p className="platform-error">{error}</p>}
        <button onClick={() => void check()}>
          <RefreshCw size={16} /> Retry connection
        </button>
      </div>
    );
  if (!session) return <Auth done={() => void check()} />;
  return (
    <div className="platform-workspace">
      {health.validationMode === "FIXTURE" && (
        <div className="platform-error">
          ISOLATED TEST FIXTURE · No Cognito, Bedrock or ECS request is sent by
          this browser harness.
        </div>
      )}
      <div className="platform-topline">
        <div>
          <span className="eyebrow">YOUR AGENT OPERATING PLATFORM</span>
          <h2>One workspace. Every agent.</h2>
          <p>
            {session.email} · Bedrock / {health.model} · {health.region}
          </p>
        </div>
        <button
          onClick={() =>
            void act(async () => {
              await platform("/auth/logout", "POST", {});
              setSession(null);
              setMessages([]);
              setSessionId(null);
              setAgents([]);
              tenantRef.current = null;
              setSelected(null);
              setProfile(null);
              setRuntime(null);
              setEvents([]);
              setPreview(null);
              setUsage([]);
              setEmergency(null);
              setMetrics(null);
              setPendingProfile(null);
              setProfileDraft("");
            })
          }
        >
          <LogOut size={15} /> Sign out
        </button>
      </div>
      {error && (
        <div className="platform-error" role="alert">
          {error}
        </div>
      )}
      {emergency?.emergency && (
        <div className="platform-error" role="alert">
          <strong>EMERGENCY STOP ACTIVE</strong>
          <p>
            Tenant execution requests are blocked. Positions are held for
            review.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await platform("/emergency-clear", "POST", {
                  expectedVersion: emergency.version,
                  acknowledgement: "CLEAR_EMERGENCY_KEEP_PAUSED",
                });
              })
            }
          >
            Clear stop · keep agents paused
          </button>
        </div>
      )}
      <div className="platform-grid">
        <aside className="platform-agent-rail">
          <div className="platform-section-label">
            <span>
              YOUR AGENTS <b>{agents.length}</b>
            </span>
            <button
              title="New conversation"
              onClick={() => {
                setSessionId(null);
                setMessages([]);
                setSelected(null);
                setPreview(null);
              }}
            >
              <MessageSquarePlus size={17} />
            </button>
          </div>
          {agents.length === 0 && (
            <div className="platform-empty">
              <Bot />
              <h3>Build your first agent</h3>
              <p>
                Describe its research, assets, strategies and limits in the
                conversation.
              </p>
            </div>
          )}
          {agents.map((a) => (
            <button
              key={a.id}
              className={`platform-agent-row ${selected === a.id ? "selected" : ""}`}
              onClick={() => {
                setSelected(a.id);
                setPreview(null);
                setRuntime(null);
                setEvents([]);
              }}
            >
              <span className="platform-agent-icon">
                <Bot size={18} />
              </span>
              <span>
                <strong>{a.data.specification.name}</strong>
                <small>
                  {a.data.specification.configuration.assets.join(" · ")} · v
                  {a.data.configurationVersion}
                  {a.data.deployment &&
                  a.data.deployment.configurationVersion !==
                    a.data.configurationVersion
                    ? ` · active v${a.data.deployment.configurationVersion}`
                    : ""}
                </small>
                <em>
                  {a.data.origin === "KRONO_MANAGED"
                    ? "KRONO MANAGED"
                    : "USER CREATED"}{" "}
                  · {a.data.state.replaceAll("_", " ")}
                </em>
              </span>
            </button>
          ))}
          <div className="platform-usage">
            <label>
              Conversation history
              <select
                aria-label="Conversation history"
                value={sessionId ?? ""}
                onChange={(event) => {
                  const id = event.target.value;
                  if (!id) return;
                  void act(async () => {
                    const r = await platform<{
                      items: {
                        data: {
                          user: string;
                          assistant: string;
                          tools: Message["tools"];
                        };
                      }[];
                    }>(`/conversations/${id}/messages?limit=100`);
                    setSessionId(id);
                    setMessages(
                      r.items.flatMap((row) => [
                        { role: "user" as const, text: row.data.user },
                        {
                          role: "assistant" as const,
                          text: row.data.assistant,
                          tools: row.data.tools,
                        },
                      ]),
                    );
                  });
                }}
              >
                <option value="">Select a saved conversation</option>
                {conversations.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.data.title} ·{" "}
                    {new Date(c.updatedAt).toLocaleDateString()}
                  </option>
                ))}
              </select>
            </label>
            <span className="eyebrow">ACCOUNT USAGE</span>
            <p>Token and runtime limits apply on the server.</p>
            <JsonDetails data={usage} label="Actual usage records" />
            <button
              onClick={() => {
                setTab("profile");
                setProfileDraft(JSON.stringify(profile?.data, null, 2));
              }}
            >
              Profile & preferences
            </button>
          </div>
        </aside>
        <section className="platform-conversation">
          <div className="platform-section-label">
            <span>
              <KronoMark /> KRONO ASSISTANT
            </span>
            <span className="muted">Controlled tools · audited changes</span>
          </div>
          <div className="platform-message-list">
            {messages.length === 0 && (
              <div className="platform-conversation-start">
                <span className="platform-prompt-mark">
                  <KronoMark />
                </span>
                <h3>Describe your next operator.</h3>
                <p>
                  Start with an idea. KRONO retrieves your saved preferences and
                  turns it into a validated agent configuration.
                </p>
                {[
                  "Create a conservative BTC momentum agent that checks every five minutes.",
                  "Create an agent that only monitors HSK news. No trading.",
                  "Show my agents and their current deployment status.",
                ].map((text) => (
                  <button key={text} disabled={busy} onClick={() => send(text)}>
                    {text}
                    <ArrowRight size={16} />
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`platform-message ${m.role}`}>
                <span className="eyebrow">
                  {m.role === "user" ? "YOU" : "KRONO"}
                </span>
                <p>{m.text}</p>
                {m.tools?.map((tool, j) => (
                  <div className="platform-tool-result" key={j}>
                    <span>
                      <CheckCircle2 size={13} />{" "}
                      {tool.name.replaceAll("_", " ")}
                    </span>
                    <JsonDetails
                      data={tool.result}
                      label="Validated tool result"
                    />
                    {typeof tool.result.actionId === "string" &&
                      typeof tool.result.digest === "string" && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await platform(
                                `/actions/${tool.result.actionId}/approve`,
                                "POST",
                                {
                                  digest: tool.result.digest,
                                  acknowledgement: "APPROVE_CHANGE",
                                },
                              );
                              setMessages((v) => [
                                ...v,
                                {
                                  role: "assistant",
                                  text: "The reviewed change was applied and audited.",
                                },
                              ]);
                            })
                          }
                        >
                          Approve reviewed change
                        </button>
                      )}
                    {typeof tool.result.digest === "string" &&
                      Boolean(tool.result.data) && (
                        <button
                          onClick={() => {
                            const row = tool.result as unknown as Preview;
                            setSelected(row.id);
                            setPreview(row);
                          }}
                        >
                          Review deployment
                        </button>
                      )}
                  </div>
                ))}
              </div>
            ))}
            {busy && (
              <p className="platform-thinking">
                <LoaderCircle size={15} className="spin" /> Retrieving state and
                validating actions…
              </p>
            )}
            <div ref={bottom} />
          </div>
          <form
            className="platform-composer"
            onSubmit={(e) => {
              e.preventDefault();
              if (input.trim() && !busy) send(input.trim());
            }}
          >
            {pendingRequest && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const r = await platform<{
                      data: {
                        status: string;
                        response?: string;
                        tools: Message["tools"];
                      };
                    }>(
                      `/conversations/${pendingRequest.sessionId}/requests/${pendingRequest.requestId}`,
                    );
                    if (r.data.status === "RUNNING")
                      throw Error(
                        "The request is still processing. It has not been resent.",
                      );
                    setMessages((v) => [
                      ...v,
                      {
                        role: "assistant",
                        text:
                          r.data.response ??
                          "The request finished without a public response",
                        tools: r.data.tools,
                      },
                    ]);
                    setPendingRequest(null);
                  })
                }
              >
                Check pending request
              </button>
            )}
            <textarea
              aria-label="Describe an agent or command"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Create an agent, inspect its work, or change a permitted setting…"
              maxLength={8000}
              rows={2}
            />
            <button
              disabled={busy || !input.trim()}
              aria-label="Send platform message"
            >
              <Send size={18} />
            </button>
            <small>
              Messages retained for the configured period. No wallet secrets.
              Deployment and important changes require review.
            </small>
          </form>
        </section>
        <aside className="platform-inspector">
          <div className="platform-section-label">
            <span>
              <Terminal size={15} /> AGENT CONTROL
            </span>
            <span className="platform-simulation">SIMULATION</span>
          </div>
          {!current ? (
            <div className="platform-empty">
              <Cpu />
              <h3>Inspect an agent</h3>
              <p>
                Select an agent to review its specification, deployment and
                actual runtime activity.
              </p>
            </div>
          ) : (
            <>
              <h3>{current.data.specification.name}</h3>
              <div className="platform-runtime-state">
                <span>{runtime?.status ?? current.data.state}</span>
                <small>
                  {runtime?.currentTask ?? "No runtime heartbeat received"}
                </small>
              </div>
              <div className="platform-runtime-controls">
                {[
                  { cmd: "PAUSE", Icon: Pause },
                  { cmd: "RESUME", Icon: Play },
                  { cmd: "RESTART", Icon: RefreshCw },
                  { cmd: "STOP", Icon: Square },
                ].map(({ cmd, Icon }) => (
                  <button
                    key={cmd}
                    title={cmd}
                    disabled={busy || !current.data.deployment}
                    onClick={() =>
                      void act(async () => {
                        await platform(
                          `/agents/${current.id}/control`,
                          "POST",
                          { command: cmd, expectedVersion: current.version },
                        );
                      })
                    }
                  >
                    <Icon size={16} />
                    <span>{cmd.toLowerCase()}</span>
                  </button>
                ))}
              </div>
              <dl className="platform-facts">
                <div>
                  <dt>Heartbeat</dt>
                  <dd>{timestamp(runtime?.heartbeatAt)}</dd>
                </div>
                <div>
                  <dt>Strategy</dt>
                  <dd>{runtime?.selectedStrategy ?? "Unavailable"}</dd>
                </div>
                <div>
                  <dt>Regime</dt>
                  <dd>{runtime?.regime ?? "Unavailable"}</dd>
                </div>
                <div>
                  <dt>Next evaluation</dt>
                  <dd>{timestamp(runtime?.nextRunAt)}</dd>
                </div>
                <div>
                  <dt>Runtime budget</dt>
                  <dd>
                    {current.data.specification.execution.maxRuntimeSeconds /
                      60}{" "}
                    min
                  </dd>
                </div>
                <div>
                  <dt>Compute</dt>
                  <dd>
                    {current.data.specification.execution.cpu} CPU units /{" "}
                    {current.data.specification.execution.memoryMiB} MiB
                  </dd>
                </div>
                <div>
                  <dt>CPU / memory usage</dt>
                  <dd>
                    {metrics?.cpuPercent == null
                      ? "Unavailable"
                      : `${metrics.cpuPercent.toFixed(1)}%`}{" "}
                    /{" "}
                    {metrics?.memoryPercent == null
                      ? "Unavailable"
                      : `${metrics.memoryPercent.toFixed(1)}%`}
                  </dd>
                </div>
                <div>
                  <dt>Equity (simulation)</dt>
                  <dd>
                    {money(runtime?.portfolio?.equity as string | undefined)}
                  </dd>
                </div>
              </dl>
              {runtime?.error && (
                <p className="platform-error">{runtime.error}</p>
              )}
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setPreview(await platform(`/agents/${current.id}/preview`));
                  })
                }
              >
                <Cloud size={16} /> Review & deploy version
              </button>
              <div className="platform-tabs">
                {[
                  "activity",
                  "configuration",
                  "logs",
                  "versions",
                  "profile",
                ].map((t) => (
                  <button
                    className={tab === t ? "active" : ""}
                    key={t}
                    onClick={() => {
                      setTab(t);
                      if (t === "profile")
                        setProfileDraft(JSON.stringify(profile?.data, null, 2));
                      if (["activity", "logs", "versions"].includes(t))
                        void act(async () => {
                          const r = await platform<{ items: unknown[] }>(
                            `/agents/${current.id}/${t === "activity" ? "events" : t}`,
                          );
                          setEvents(r.items);
                        });
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
              {tab === "configuration" ? (
                <JsonDetails
                  data={current.data.specification}
                  label="Versioned specification"
                />
              ) : tab !== "profile" ? (
                <div className="platform-event-list">
                  {events.length ? (
                    events.map((event, i) => (
                      <JsonDetails
                        key={i}
                        data={event}
                        label={`Recorded ${tab} ${i + 1}`}
                      />
                    ))
                  ) : (
                    <p className="muted">
                      No {tab} records loaded. Select the tab to retrieve them.
                    </p>
                  )}
                </div>
              ) : null}
              <details className="platform-delete">
                <summary>
                  <Trash2 size={14} /> Delete agent
                </summary>
                <p>
                  Stops the runtime and requests infrastructure deletion. Type{" "}
                  <code>DELETE {current.id}</code> to confirm.
                </p>
                <input
                  aria-label="Confirm agent deletion"
                  value={deleteText}
                  onChange={(e) => setDeleteText(e.target.value)}
                />
                <button
                  disabled={busy || deleteText !== `DELETE ${current.id}`}
                  onClick={() =>
                    void act(async () => {
                      await platform(`/agents/${current.id}/control`, "POST", {
                        command: "TERMINATE",
                        expectedVersion: current.version,
                        acknowledgement: deleteText,
                      });
                      setSelected(null);
                      setDeleteText("");
                    })
                  }
                >
                  Delete reviewed agent
                </button>
              </details>
            </>
          )}
          {tab === "profile" && profile && (
            <div className="platform-profile">
              <h3>Saved profile</h3>
              <p>
                Review your preferences and risk limits. The server validates
                all fields and agent-level restrictions.
              </p>
              <textarea
                aria-label="Profile configuration"
                value={profileDraft}
                onChange={(e) => setProfileDraft(e.target.value)}
                rows={14}
              />
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () =>
                    setPendingProfile(
                      await platform("/profile/preview", "POST", {
                        profile: JSON.parse(profileDraft),
                        expectedVersion: profile.version,
                      }),
                    ),
                  )
                }
              >
                Validate changes
              </button>
              {pendingProfile && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await platform(
                        `/actions/${pendingProfile.actionId}/approve`,
                        "POST",
                        {
                          digest: pendingProfile.digest,
                          acknowledgement: "APPROVE_CHANGE",
                        },
                      );
                      setPendingProfile(null);
                    })
                  }
                >
                  Approve profile & risk changes
                </button>
              )}
            </div>
          )}
          {preview && (
            <div className="platform-deployment-preview">
              <span className="eyebrow">DEPLOYMENT APPROVAL</span>
              <h3>Review version {preview.data.configurationVersion}</h3>
              <p>
                {preview.data.specification.configuration.assets.join(", ")} ·{" "}
                {preview.data.specification.configuration.strategies.join(", ")}
              </p>
              <JsonDetails
                data={preview.data.specification}
                label="Exact specification & permissions"
              />
              {preview.warnings?.map((w) => (
                <p key={w}>{w}</p>
              ))}
              <small>Image: {preview.image}</small>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await platform(`/agents/${preview.id}/deploy`, "POST", {
                      expectedVersion: preview.version,
                      digest: preview.digest,
                      acknowledgement: "DEPLOY_SIMULATION",
                    });
                    setPreview(null);
                  })
                }
              >
                <Cloud size={16} /> Authorize AWS simulation deployment
              </button>
              <button onClick={() => setPreview(null)}>Cancel</button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
