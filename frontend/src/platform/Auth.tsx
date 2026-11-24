import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  LoaderCircle,
  ShieldCheck,
  Trophy,
} from "lucide-react";
import { KronoBrand } from "../brand";
import { ThemeToggle } from "../ThemeToggle";
import { platform } from "./client";
import { MarketTicker } from "./MarketTicker";

type Mode = "login" | "register" | "verify" | "forgot" | "reset";

interface GoogleAccounts {
  id: {
    initialize(options: {
      client_id: string;
      callback: (response: { credential?: string }) => void;
      ux_mode?: "popup";
      context?: "signin" | "signup";
    }): void;
    renderButton(
      parent: HTMLElement,
      options: Record<string, string | number>,
    ): void;
  };
}

declare global {
  interface Window {
    google?: { accounts: GoogleAccounts };
  }
}

let googleScript: Promise<GoogleAccounts> | undefined;
function loadGoogle() {
  googleScript ??= new Promise<GoogleAccounts>((resolve, reject) => {
    if (window.google?.accounts) return resolve(window.google.accounts);
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () =>
      window.google?.accounts
        ? resolve(window.google.accounts)
        : reject(Error("Google sign-in did not load."));
    script.onerror = () => {
      googleScript = undefined;
      reject(Error("Google sign-in could not load. Check your connection."));
    };
    document.head.append(script);
  });
  return googleScript;
}

/** "Continue with Google", shown only when the deployment configures a client ID. */
function GoogleSignIn({
  signup,
  done,
  onError,
}: {
  signup: boolean;
  done: () => void;
  onError: (message: string) => void;
}) {
  const [clientId, setClientId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const slot = useRef<HTMLDivElement>(null);
  // Held in refs so typing elsewhere in the form never re-initializes Google's button.
  const callbacks = useRef({ done, onError });
  callbacks.current = { done, onError };

  useEffect(() => {
    let active = true;
    platform<{ google: { clientId: string } | null }>("/auth/providers")
      .then(({ google }) => active && setClientId(google?.clientId ?? null))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!clientId) return;
    let active = true;
    loadGoogle()
      .then((accounts) => {
        if (!active || !slot.current) return;
        accounts.id.initialize({
          client_id: clientId,
          ux_mode: "popup",
          context: signup ? "signup" : "signin",
          callback: ({ credential }) => {
            const { done, onError } = callbacks.current;
            if (!credential) return onError("Google sign-in was cancelled.");
            setWorking(true);
            platform("/auth/google", "POST", { credential })
              .then(done)
              .catch((err: Error) => onError(err.message))
              .finally(() => setWorking(false));
          },
        });
        const dark =
          document.documentElement.dataset.theme === "dark" ||
          (document.documentElement.dataset.theme !== "light" &&
            matchMedia("(prefers-color-scheme: dark)").matches);
        accounts.id.renderButton(slot.current, {
          type: "standard",
          theme: dark ? "filled_black" : "outline",
          size: "large",
          shape: "pill",
          text: signup ? "signup_with" : "continue_with",
          logo_alignment: "left",
          width: Math.min(400, slot.current.clientWidth || 320),
        });
      })
      .catch((err: Error) => active && callbacks.current.onError(err.message));
    return () => {
      active = false;
    };
  }, [clientId, signup]);

  if (!clientId) return null;
  return (
    <div className="kx-auth-google" aria-busy={working || undefined}>
      <div ref={slot} className="kx-auth-google-button" />
      <p className="kx-auth-divider">
        <span>or use your email</span>
      </p>
    </div>
  );
}

const headings: Record<Mode, [string, string]> = {
  login: ["Welcome back", "Sign in to manage your agents and portfolio."],
  register: [
    "Create your account",
    "Start with 10,000 virtual USDT. No card, no exchange account needed.",
  ],
  verify: ["Verify your email", "Enter the code we sent to your inbox."],
  forgot: [
    "Reset your password",
    "We'll send a reset code if the account exists.",
  ],
  reset: ["Choose a new password", "Enter the code and your new password."],
};

export function Auth({
  done,
  focusEmail = false,
  register = false,
}: {
  done: () => void;
  focusEmail?: boolean;
  register?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(register ? "register" : "login"),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState(""),
    [code, setCode] = useState(""),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState("");
  const emailInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusEmail) emailInput.current?.focus({ preventScroll: true });
  }, [focusEmail]);

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setNotice("");
  }

  async function submit() {
    if (mode === "login") {
      await platform("/auth/login", "POST", { email, password });
      done();
    }
    if (mode === "register") {
      const result = await platform<{ verificationRequired?: boolean }>(
        "/auth/register",
        "POST",
        { email, password, displayName: name },
      );
      if (result.verificationRequired === false) return done();
      switchMode("verify");
      setNotice("Check your email for a verification code.");
    }
    if (mode === "verify") {
      await platform("/auth/verify", "POST", { email, code });
      switchMode("login");
      setNotice("Email verified. Sign in to continue.");
    }
    if (mode === "forgot") {
      await platform("/auth/forgot", "POST", { email });
      switchMode("reset");
      setNotice(
        "If the account is eligible, a reset code will arrive by email.",
      );
    }
    if (mode === "reset") {
      await platform("/auth/reset", "POST", { email, code, password });
      switchMode("login");
      setNotice("Password updated. Sign in with your new password.");
    }
  }

  const [title, subtitle] = headings[mode];
  return (
    <div className="kx-auth">
      <aside className="kx-auth-story">
        <a className="kx-brand" href="#/">
          <KronoBrand />
        </a>
        <div>
          <h2>
            Automated crypto trading,
            <br />
            <span className="kx-accent-text">built by you.</span>
          </h2>
          <p>
            Tell the AI what you want to trade, test it on real market data, and
            let your agent run around the clock, on paper first, then live.
          </p>
          <ul className="kx-auth-points">
            <li>
              <Bot size={18} aria-hidden /> Agents keep trading after you close
              the tab
            </li>
            <li>
              <Trophy size={18} aria-hidden /> Compete on the public agent
              strategy rankings
            </li>
            <li>
              <ShieldCheck size={18} aria-hidden /> Server-side risk limits on
              every order
            </li>
          </ul>
        </div>
        <MarketTicker />
      </aside>
      <div className="kx-auth-panel">
        <div className="kx-auth-top">
          <a className="kx-brand kx-auth-home" href="#/">
            <KronoBrand />
          </a>
          <a className="kx-back" href="#/">
            <ArrowLeft size={15} /> Home
          </a>
          <ThemeToggle />
        </div>
        <form
          className="kx-auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            setPending(true);
            setError("");
            void submit()
              .catch((err: Error) => setError(err.message))
              .finally(() => setPending(false));
          }}
        >
          <h1>{title}</h1>
          <p className="muted">{subtitle}</p>
          {notice && (
            <p className="kx-notice" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="platform-error" role="alert">
              {error}
            </p>
          )}
          {(mode === "login" || mode === "register") && (
            <GoogleSignIn
              signup={mode === "register"}
              done={done}
              onError={setError}
            />
          )}
          {mode === "register" && (
            <label>
              Display name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="nickname"
                placeholder="Shown in strategy rankings"
                required
                maxLength={80}
              />
            </label>
          )}
          <label>
            Email
            <input
              type="email"
              ref={emailInput}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
              required
              maxLength={254}
            />
          </label>
          {(mode === "verify" || mode === "reset") && (
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
          {(mode === "login" || mode === "register" || mode === "reset") && (
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                minLength={mode === "login" ? 1 : 8}
                maxLength={128}
                required
              />
              {mode !== "login" && <small>At least 8 characters.</small>}
            </label>
          )}
          <button className="primary kx-block" disabled={pending}>
            {pending ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <ArrowRight size={16} />
            )}
            {mode === "login"
              ? "Sign in"
              : mode === "register"
                ? "Create account"
                : "Continue"}
          </button>
          <div className="kx-auth-links">
            {mode === "login" ? (
              <>
                <span>
                  New to Krono?{" "}
                  <button type="button" onClick={() => switchMode("register")}>
                    Create an account
                  </button>
                </span>
                <button type="button" onClick={() => switchMode("forgot")}>
                  Forgot password?
                </button>
              </>
            ) : (
              <span>
                {mode === "register" ? "Already have an account? " : ""}
                <button type="button" onClick={() => switchMode("login")}>
                  Back to sign in
                </button>
              </span>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
