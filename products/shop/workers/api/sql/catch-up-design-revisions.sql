-- Repeat after the dual-write Worker is live to close the migration/deploy window.
INSERT INTO `design_revisions` (
	`id`, `design_id`, `fingerprint`, `artwork_key`, `content_type`,
	`byte_size`, `sha256`, `crop_x`, `crop_y`, `crop_zoom`,
	`placement_x`, `placement_y`, `placement_width`, `depth`, `created_at`
)
SELECT
	(
		SELECT MIN(`candidate_products`.`id`)
		FROM `products` AS `candidate_products`
		WHERE
			`candidate_products`.`design_id` = `designs`.`id`
			AND `candidate_products`.`design_revision_id` IS NULL
	),
	`designs`.`id`,
	'revision-v1:' || `designs`.`sha256` || ':settings-v1:' ||
		printf(
			'%!.17g,%!.17g,%!.17g,%!.17g,%!.17g,%!.17g,%!.17g',
			`designs`.`crop_x`,
			`designs`.`crop_y`,
			`designs`.`crop_zoom`,
			`designs`.`placement_x`,
			`designs`.`placement_y`,
			`designs`.`placement_width`,
			`designs`.`depth`
		),
	`designs`.`artwork_key`,
	`designs`.`content_type`,
	`designs`.`byte_size`,
	`designs`.`sha256`,
	`designs`.`crop_x`,
	`designs`.`crop_y`,
	`designs`.`crop_zoom`,
	`designs`.`placement_x`,
	`designs`.`placement_y`,
	`designs`.`placement_width`,
	`designs`.`depth`,
	`designs`.`updated_at`
FROM `designs`
WHERE
	`designs`.`sha256` <> ''
	AND `designs`.`artwork_key` <> 'designs/' || `designs`.`id` || '/pending'
	AND EXISTS (
		SELECT 1
		FROM `products`
		WHERE
			`products`.`design_id` = `designs`.`id`
			AND `products`.`design_revision_id` IS NULL
	)
ON CONFLICT (`design_id`, `fingerprint`) DO NOTHING;--> statement-breakpoint
UPDATE `products`
SET `design_revision_id` = (
	SELECT `design_revisions`.`id`
	FROM `design_revisions`
	JOIN `designs` ON `designs`.`id` = `design_revisions`.`design_id`
	WHERE
		`design_revisions`.`design_id` = `products`.`design_id`
		AND `design_revisions`.`fingerprint` =
			'revision-v1:' || `designs`.`sha256` || ':settings-v1:' ||
			printf(
				'%!.17g,%!.17g,%!.17g,%!.17g,%!.17g,%!.17g,%!.17g',
				`designs`.`crop_x`,
				`designs`.`crop_y`,
				`designs`.`crop_zoom`,
				`designs`.`placement_x`,
				`designs`.`placement_y`,
				`designs`.`placement_width`,
				`designs`.`depth`
			)
)
WHERE
	`products`.`design_id` IS NOT NULL
	AND `products`.`design_revision_id` IS NULL
	AND EXISTS (
		SELECT 1
		FROM `designs`
		WHERE
			`designs`.`id` = `products`.`design_id`
			AND `designs`.`sha256` <> ''
			AND `designs`.`artwork_key` <>
				'designs/' || `designs`.`id` || '/pending'
	);--> statement-breakpoint
UPDATE `designs`
SET `finalized_at` = COALESCE(`finalized_at`, `updated_at`)
WHERE EXISTS (
	SELECT 1
	FROM `design_revisions`
	WHERE `design_revisions`.`design_id` = `designs`.`id`
);
