import { FormEvent, useMemo, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";

type Platform = "native mobile" | "webapp" | "desktop app";

interface Idea {
  rank: number;
  name: string;
  tagline: string;
  platform: Platform | "cross-platform";
  targetUser: string;
  concept: string;
  whyNow: string;
  viralHook: string;
  buildScope: string;
  difficulty: "weekend" | "one-week" | "multi-week";
}

interface IdeasResponse {
  ideas: Idea[];
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

  const viralityTone = useMemo(() => {
    if (virality < 34) return "Focused";
    if (virality < 67) return "Shareable";
    return "Wildfire";
  }, [virality]);

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

  return (
    <main className="app-shell">
      <section className="intro-band" aria-labelledby="page-title">
        <div className="brand-lockup">
          <img src="/brainstorm-city-logo.png" alt="" className="brand-logo" />
          <div>
            <p className="eyebrow">Hit app ideation</p>
            <h1 id="page-title">Brainstorm City</h1>
          </div>
        </div>
        <p className="intro-copy">Ten crisp product bets, tuned for the platform, audience, and buzz level you want.</p>
      </section>

      <section className="workspace" aria-label="App idea generator">
        <form className="generator" onSubmit={generateIdeas}>
          <label className="field">
            <span>Theme or direction</span>
            <textarea
              value={direction}
              onChange={(event) => setDirection(event.target.value)}
              placeholder="Example: useful tools for creators, local communities, better meetings..."
              rows={5}
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
            <span>Target audience</span>
            <input
              value={targetAudience}
              onChange={(event) => setTargetAudience(event.target.value)}
              placeholder="Example: indie hackers, nurses, teachers, new parents"
            />
          </label>

          <label className="field virality-field">
            <span>Virality</span>
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
              <span>Viral</span>
            </span>
          </label>

          <button className="generate-button" type="submit" disabled={isLoading}>
            {isLoading ? <Loader2 aria-hidden="true" className="spin" size={18} /> : <Sparkles aria-hidden="true" size={18} />}
            {isLoading ? "Generating" : "Generate app ideas"}
          </button>

          {error ? <p className="error-panel">{error}</p> : null}
        </form>

        <div className="result-surface" aria-live="polite">
          {ideas.length === 0 && !isLoading ? (
            <div className="empty-state">
              <span className="empty-kicker">City grid clear</span>
              <p>Your ranked ideas will land here as polished build cards.</p>
            </div>
          ) : null}

          {isLoading ? (
            <div className="loading-state">
              <span />
              <p>Surveying markets, hooks, and weekend-build angles...</p>
            </div>
          ) : null}

          {ideas.length > 0 ? (
            <div className="ideas-grid">
              {ideas.map((idea) => (
                <article className="idea-card" key={`${idea.rank}-${idea.name}`}>
                  <div className="idea-card-header">
                    <span className="rank">#{idea.rank}</span>
                    <span className="platform-pill">{idea.platform}</span>
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
                      <dt>Why now</dt>
                      <dd>{idea.whyNow}</dd>
                    </div>
                    <div>
                      <dt>Viral hook</dt>
                      <dd>{idea.viralHook}</dd>
                    </div>
                    <div>
                      <dt>MVP scope</dt>
                      <dd>{idea.buildScope}</dd>
                    </div>
                  </dl>
                  <span className="difficulty">{idea.difficulty}</span>
                </article>
              ))}
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

export default App;
