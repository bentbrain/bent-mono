-- Preserve v4 jobs and objects so this renderer update remains reversible,
-- while queueing one immutable v5 render for every active v4 product variant.
INSERT INTO `story_video_jobs` (
	`id`, `product_id`, `design_revision_id`, `colour`, `renderer_version`,
	`story_key`, `status`, `attempt_count`, `output_byte_size`, `last_error`,
	`created_at`, `updated_at`, `rendered_at`
)
SELECT
	`story_video_jobs`.`id` || '-v5',
	`story_video_jobs`.`product_id`,
	`story_video_jobs`.`design_revision_id`,
	`story_video_jobs`.`colour`,
	'story-video-renderer-v5',
	replace(`story_video_jobs`.`story_key`, 'story-videos/v4/', 'story-videos/v5/'),
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
WHERE `story_video_jobs`.`renderer_version` = 'story-video-renderer-v4'
	AND `products`.`status` = 'active'
ON CONFLICT (`product_id`, `colour`, `renderer_version`) DO NOTHING;
