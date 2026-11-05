-- Story videos are immutable product media. D1 owns orchestration state while
-- the renderer owns the MP4 object in its dedicated R2 bucket.
CREATE TABLE `story_video_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`design_revision_id` text NOT NULL,
	`colour` text NOT NULL CHECK (`colour` IN ('Black', 'Cream', 'White')),
	`renderer_version` text NOT NULL,
	`story_key` text NOT NULL UNIQUE,
	`status` text DEFAULT 'queued' NOT NULL CHECK (`status` IN ('queued', 'rendering', 'ready', 'failed')),
	`attempt_count` integer DEFAULT 0 NOT NULL CHECK (`attempt_count` >= 0),
	`output_byte_size` integer CHECK (`output_byte_size` IS NULL OR `output_byte_size` > 0),
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`rendered_at` integer,
	FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT,
	FOREIGN KEY (`design_revision_id`) REFERENCES `design_revisions` (`id`) ON DELETE RESTRICT,
	UNIQUE (`product_id`, `colour`, `renderer_version`)
);
--> statement-breakpoint
CREATE INDEX `story_video_jobs_revision_status_idx`
	ON `story_video_jobs` (`design_revision_id`, `status`, `created_at`);
--> statement-breakpoint
CREATE INDEX `story_video_jobs_product_status_idx`
	ON `story_video_jobs` (`product_id`, `status`);
