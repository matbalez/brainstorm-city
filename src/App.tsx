import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Copy, Hammer, Loader2, X } from "lucide-react";

import { signBuildRequest, type BuzzBuildIdea } from "./buildOnBuzz";

type Platform = "native mobile" | "webapp" | "desktop app";

type Idea = BuzzBuildIdea;

interface IdeasResponse {
  ideas: Idea[];
}

interface BuildResponse {
  channelId?: string;
  channelName?: string;
  message?: string;
}

const platforms: Platform[] = ["native mobile", "webapp", "desktop app"];

function App() {
  const [direction, setDirection] = useState("");
  const [platform, setPlatform] = useState<Platform>("webapp");
  const [targetAudience, setTargetAudience] = useState("");
  const [virality, setVirality] = useState(62);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copiedRank, setCopiedRank] = useState<number | null>(null);
  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
  const [buildError, setBuildError] = useState("");
  const [buildResult, setBuildResult] = useState<BuildResponse | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const buildDialogRef = useRef<HTMLDialogElement>(null);
  const nsecInputRef = useRef<HTMLInputElement>(null);

  const viralityTone = useMemo(() => {
    if (virality < 34) return "Focused";
    if (virality < 67) return "Shareable";
    return "Wildfire";
  }, [virality]);

  useEffect(() => {
    const dialog = buildDialogRef.current;
    if (!dialog) return;

    if (selectedIdea && !dialog.open) {
      dialog.showModal();
      window.setTimeout(() => nsecInputRef.current?.focus(), 0);
    } else if (!selectedIdea && dialog.open) {
      dialog.close();
    }
  }, [selectedIdea]);

  async function generateIdeas(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direction,
          platform,
          targetAudience,
          virality
        })
      });

      const data = (await response.json()) as IdeasResponse & { message?: string };

      if (!response.ok) {
        throw new Error(data.message ?? "Brainstorm City could not generate ideas.");
      }

      setIdeas(data.ideas ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Brainstorm City could not generate ideas.");
    } finally {
      setIsLoading(false);
    }
  }

  async function copyIdea(idea: Idea) {
    const text = [
      `#${idea.rank} ${idea.name}`,
      idea.tagline,
      "",
      idea.concept,
      "",
      `Platform: ${idea.platform}`,
      `Audience: ${idea.targetUser}`,
      `Hook: ${idea.viralHook}`,
      `MVP: ${idea.buildScope}`,
      `Difficulty: ${idea.difficulty}`
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      setCopiedRank(idea.rank);
      window.setTimeout(() => {
        setCopiedRank((current) => (current === idea.rank ? null : current));
      }, 1600);
    } catch {
      setError("Could not copy — your browser blocked clipboard access.");
    }
  }

  function openBuildDialog(idea: Idea) {
    setBuildError("");
    setBuildResult(null);
    setSelectedIdea(idea);
  }

  function closeBuildDialog() {
    if (isBuilding) return;
    if (nsecInputRef.current) nsecInputRef.current.value = "";
    setSelectedIdea(null);
    setBuildError("");
    setBuildResult(null);
  }

  async function buildOnBuzz(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedIdea || !nsecInputRef.current) return;

    setBuildError("");
    setBuildResult(null);
    setIsBuilding(true);

    try {
      const signed = await signBuildRequest(nsecInputRef.current.value, selectedIdea);
      nsecInputRef.current.value = "";

      const response = await fetch("/api/build-on-buzz", {
        method: "POST",
        headers: {
          Authorization: signed.authorization,
          "Content-Type": "application/json"
        },
        body: signed.body
      });
      const data = (await response.json()) as BuildResponse;

      if (!response.ok) {
        throw new Error(data.message ?? "Brainstorm City could not create the Buzz build room.");
      }

      setBuildResult(data);
    } catch (caught) {
      setBuildError(
        caught instanceof Error
          ? caught.message
          : "Brainstorm City could not create the Buzz build room."
      );
    } finally {
      if (nsecInputRef.current) nsecInputRef.current.value = "";
      setIsBuilding(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="intro-band" aria-labelledby="page-title">
        <div className="brand-lockup">
          <img src="/brainstorm-city-logo.svg" alt="" className="brand-logo" />
          <div>
            <h1 id="page-title">Brainstorm City</h1>
            <p>Generate ranked app ideas.</p>
          </div>
        </div>
      </section>

      <section className="workspace" aria-label="App idea generator">
        <form className="generator" onSubmit={generateIdeas}>
          <label className="field">
            <span>Direction</span>
            <textarea
              value={direction}
              onChange={(event) => setDirection(event.target.value)}
              placeholder="Useful tools for creators, local communities, better meetings..."
              rows={4}
            />
          </label>

          <fieldset className="field">
            <legend>Platform</legend>
            <div className="segmented">
              {platforms.map((option) => (
                <button
                  type="button"
                  className={platform === option ? "segment active" : "segment"}
                  key={option}
                  onClick={() => setPlatform(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="field">
            <span>Audience</span>
            <input
              value={targetAudience}
              onChange={(event) => setTargetAudience(event.target.value)}
              placeholder="Indie hackers, nurses, teachers, new parents"
            />
          </label>

          <label className="field virality-field">
            <span>Reach</span>
            <input
              type="range"
              min="0"
              max="100"
              value={virality}
              onChange={(event) => setVirality(Number(event.target.value))}
            />
            <span className="range-row">
              <span>Niche</span>
              <strong>{viralityTone}</strong>
              <span>Mass</span>
            </span>
          </label>

          <button className="generate-button" type="submit" disabled={isLoading}>
            {isLoading ? <Loader2 aria-hidden="true" className="spin" size={18} /> : <ArrowRight aria-hidden="true" size={18} />}
            {isLoading ? "Generating" : "Generate"}
          </button>

          {error ? <p className="error-panel">{error}</p> : null}
        </form>

        <div className="result-surface" aria-live="polite">
          {ideas.length === 0 && !isLoading ? (
            <div className="empty-state">
              <p>Results appear here.</p>
            </div>
          ) : null}

          {isLoading ? (
            <div className="loading-state">
              <span />
              <p>Generating...</p>
            </div>
          ) : null}

          {ideas.length > 0 ? (
            <div className="ideas-grid">
              {ideas.map((idea) => (
                <article className="idea-card" key={`${idea.rank}-${idea.name}`}>
                  <div className="idea-card-header">
                    <span className="rank">#{idea.rank}</span>
                    <div className="card-actions">
                      <span className="platform-pill">{idea.platform}</span>
                      <button
                        type="button"
                        className={copiedRank === idea.rank ? "copy-button copied" : "copy-button"}
                        onClick={() => copyIdea(idea)}
                        aria-label={`Copy ${idea.name} to clipboard`}
                      >
                        {copiedRank === idea.rank ? (
                          <Check aria-hidden="true" size={13} />
                        ) : (
                          <Copy aria-hidden="true" size={13} />
                        )}
                        {copiedRank === idea.rank ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </div>
                  <h2>{idea.name}</h2>
                  <p className="tagline">{idea.tagline}</p>
                  <p>{idea.concept}</p>
                  <dl>
                    <div>
                      <dt>Audience</dt>
                      <dd>{idea.targetUser}</dd>
                    </div>
                    <div>
                      <dt>Hook</dt>
                      <dd>{idea.viralHook}</dd>
                    </div>
                    <div>
                      <dt>MVP</dt>
                      <dd>{idea.buildScope}</dd>
                    </div>
                  </dl>
                  <div className="idea-card-footer">
                    <span className="difficulty">{idea.difficulty}</span>
                    <button
                      type="button"
                      className="build-button"
                      onClick={() => openBuildDialog(idea)}
                    >
                      <Hammer aria-hidden="true" size={14} />
                      Build it on Buzz
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <dialog
        ref={buildDialogRef}
        className="build-dialog"
        aria-labelledby="build-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          closeBuildDialog();
        }}
      >
        {selectedIdea ? (
          <form className="build-dialog-form" onSubmit={buildOnBuzz}>
            <div className="build-dialog-heading">
              <div>
                <p className="dialog-kicker">Build on Buzz</p>
                <h2 id="build-dialog-title">{selectedIdea.name}</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                onClick={closeBuildDialog}
                disabled={isBuilding}
                aria-label="Close build dialog"
              >
                <X aria-hidden="true" size={18} />
              </button>
            </div>

            {buildResult ? (
              <div className="build-success" role="status">
                <Check aria-hidden="true" size={20} />
                <div>
                  <strong>Build room created</strong>
                  <p>
                    <span>{buildResult.channelName}</span> is waiting in Flint with the full idea
                    and your kickoff mention.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <label className="field">
                  <span>Enter your nsec for the Flint Buzz community</span>
                  <input
                    ref={nsecInputRef}
                    type="password"
                    name="flint-nsec"
                    placeholder="nsec1..."
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={isBuilding}
                    required
                  />
                </label>
                <p className="security-note">
                  Your nsec stays in this browser. It signs one short-lived authorization and is
                  cleared immediately; Brainstorm City never sends or stores the key.
                </p>
              </>
            )}

            {buildError ? <p className="error-panel">{buildError}</p> : null}

            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={closeBuildDialog}
                disabled={isBuilding}
              >
                {buildResult ? "Done" : "Cancel"}
              </button>
              {!buildResult ? (
                <button className="build-submit" type="submit" disabled={isBuilding}>
                  {isBuilding ? (
                    <Loader2 aria-hidden="true" className="spin" size={17} />
                  ) : (
                    <Hammer aria-hidden="true" size={17} />
                  )}
                  {isBuilding ? "Creating room" : "Create build room"}
                </button>
              ) : null}
            </div>
          </form>
        ) : null}
      </dialog>
    </main>
  );
}

export default App;
