-- Null preserves the existing shared-placement composition. A new immutable
-- inset revision may opt into its own chest placement for repeated portraits.
ALTER TABLE design_revisions ADD video_placement_x REAL;
--> statement-breakpoint
ALTER TABLE design_revisions ADD video_placement_y REAL;
--> statement-breakpoint
ALTER TABLE design_revisions ADD video_placement_width REAL CHECK (
  (video_placement_x IS NULL AND video_placement_y IS NULL AND video_placement_width IS NULL)
  OR (video_placement_x IS NOT NULL AND video_placement_y IS NOT NULL AND video_placement_width IS NOT NULL
    AND typeof(video_placement_x) IN ('integer', 'real') AND typeof(video_placement_y) IN ('integer', 'real')
    AND typeof(video_placement_width) IN ('integer', 'real')
    AND video_placement_x >= 0 AND video_placement_y >= 0
    AND video_placement_width > 0 AND video_placement_width < 1
    AND video_placement_x + video_placement_width <= 1
    AND video_placement_y + video_placement_width <= 1)
);
