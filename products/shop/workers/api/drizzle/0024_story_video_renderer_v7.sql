-- The physical print-area geometry is now the single source for product media.
-- Retain v6 jobs and objects for rollback, and render active products into a
-- new immutable namespace so cached videos cannot preserve the old geometry.
INSERT INTO `story_video_jobs` (
	`id`, `product_id`, `design_revision_id`, `colour`, `renderer_version`,
	`story_key`, `status`, `attempt_count`, `output_byte_size`, `last_error`,
	`created_at`, `updated_at`, `rendered_at`
)
SELECT
	`story_video_jobs`.`id` || '-v7',
	`story_video_jobs`.`product_id`,
	`story_video_jobs`.`design_revision_id`,
	`story_video_jobs`.`colour`,
	'story-video-renderer-v7',
	replace(`story_video_jobs`.`story_key`, 'story-videos/v6/', 'story-videos/v7/'),
	'queued',
	0,
	NULL,
	NULL,
	`story_video_jobs`.`created_at`,
	`story_video_jobs`.`created_at`,
	NULL
FROM `story_video_jobs`
INNER JOIN `products`
	ON `products`.`id` = `story_video_jobs`.`product_id`
WHERE `story_video_jobs`.`renderer_version` = 'story-video-renderer-v6'
	AND `products`.`status` = 'active'
ON CONFLICT (`product_id`, `colour`, `renderer_version`) DO NOTHING;
