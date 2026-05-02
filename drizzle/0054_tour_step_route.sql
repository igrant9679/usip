-- 0054_tour_step_route.sql
-- Add routeTo column to tour_steps so each step can navigate to the correct page
-- before spotlighting its target element.
ALTER TABLE `tour_steps`
  ADD COLUMN `routeTo` varchar(200) NULL AFTER `targetDataTourId`;
