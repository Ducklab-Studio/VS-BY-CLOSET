-- Preserve the accepted plan; existing reservations keep their recorded dates.
ALTER TABLE reservations ADD COLUMN calculated_return_date date;
ALTER TABLE reservations ADD COLUMN rental_duration_days integer;
