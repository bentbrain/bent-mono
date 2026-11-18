import { exercises } from "../domain";
import { guides } from "../guides";
export function ExerciseGuide({ id }: { id: string }) {
  const guide = guides.find((g) => g.id === id);
  if (!guide)
    return (
      <p>
        Use a familiar movement and a light practice set. Ask a qualified
        trainer for setup and form guidance.
      </p>
    );
  return (
    <details className="guide" data-feedback-id={`guide-${id}`}>
      <summary>
        {exercises.find((exercise) => exercise.id === id)?.name ?? "Exercise"}{" "}
        guide
      </summary>
      <p>{guide.setup}</p>
      <ol>
        {guide.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p>{guide.avoid}</p>
      <figure className="exercise-illustration">
        <a
          href={`/exercise-guides/${guide.id}.png`}
          target="_blank"
          rel="noreferrer"
        >
          <img
            src={`/exercise-guides/${guide.id}.png`}
            alt={guide.illustrationAlt}
            width={1024}
            height={1536}
            loading="lazy"
            decoding="async"
          />
          <span>Open illustration at full size ↗</span>
        </a>
        <figcaption>
          AI-generated reference. Compare both views with the written cues and
          video demonstration.
        </figcaption>
      </figure>
      <a
        href={`https://www.youtube.com/watch?v=${guide.video}`}
        target="_blank"
        rel="noreferrer"
      >
        Watch tutorial · {guide.credit} ↗
      </a>
      <p className="muted">
        Tutorial opens on YouTube. Start light and stop if a movement hurts.
      </p>
    </details>
  );
}
