import { useState } from "react";
import {
  ArrowRight,
  Cloud,
  Fingerprint,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { KronoMark } from "../brand";
import { platform } from "./client";

export function Auth({ done }: { done: () => void }) {
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
          Research markets, build strategies, and run autonomous agents with
          virtual funds.
        </p>
        <div className="platform-assurances">
          <span>
            <Fingerprint size={18} /> Verified identity
          </span>
          <span>
            <ShieldCheck size={18} /> Isolated workspaces
          </span>
          <span>
            <Cloud size={18} /> Simulated trading
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
        <small>Use your Krono account to sign in.</small>
      </form>
    </div>
  );
}
