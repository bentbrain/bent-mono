import { guides } from "../guides";
export function ExerciseGuide({ id }: { id: string }) {
  const guide = guides.find((g) => g.id === id);
  if (!guide)
    return (
      <p>
        Add setup and form notes to your custom exercise name. Use a familiar
        movement and a light practice set.
      </p>
    );
  return (
    <details className="guide" data-feedback-id={`guide-${id}`}>
      <summary>How to do this exercise</summary>
      <p>{guide.setup}</p>
      <ol>
        {guide.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p>{guide.avoid}</p>
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
