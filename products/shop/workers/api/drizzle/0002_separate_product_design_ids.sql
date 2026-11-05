UPDATE `designs`
SET `id` = '43609485-55c3-419a-bffa-f606edc02d98'
WHERE `id` = '8f48ee90-08d8-4c6c-b369-0444a20ddd25';
--> statement-breakpoint
INSERT INTO `products` (
	`id`,
	`base_product_id`,
	`design_id`,
	`shopify_handle`,
	`status`,
	`created_at`,
	`deleted_at`
) VALUES (
	'a51b7acf-77e9-4762-83c4-62d96dd8942c',
	'a51b7acf-77e9-4762-83c4-62d96dd8942c',
	NULL,
	'bent-shirt',
	'active',
	1786574017526,
	NULL
);
--> statement-breakpoint
UPDATE `products`
SET
	`base_product_id` = 'a51b7acf-77e9-4762-83c4-62d96dd8942c',
	`design_id` = CASE
		WHEN EXISTS (
			SELECT 1
			FROM `designs`
			WHERE `id` = '43609485-55c3-419a-bffa-f606edc02d98'
		) THEN '43609485-55c3-419a-bffa-f606edc02d98'
		ELSE NULL
	END
WHERE `id` = '8f48ee90-08d8-4c6c-b369-0444a20ddd25';
