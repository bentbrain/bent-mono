-- Retain v5 jobs and objects for rollback. The new copy and filter order get
-- their own immutable keys; existing cached MP4s are never overwritten.
INSERT INTO `story_video_jobs` (
	`id`, `product_id`, `design_revision_id`, `colour`, `renderer_version`,
	`story_key`, `status`, `attempt_count`, `output_byte_size`, `last_error`,
	`created_at`, `updated_at`, `rendered_at`
)
SELECT
	`story_video_jobs`.`id` || '-v6',
	`story_video_jobs`.`product_id`,
	`story_video_jobs`.`design_revision_id`,
	`story_video_jobs`.`colour`,
	'story-video-renderer-v6',
	replace(`story_video_jobs`.`story_key`, 'story-videos/v5/', 'story-videos/v6/'),
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
WHERE `story_video_jobs`.`renderer_version` = 'story-video-renderer-v5'
	AND `products`.`status` = 'active'
ON CONFLICT (`product_id`, `colour`, `renderer_version`) DO NOTHING;
