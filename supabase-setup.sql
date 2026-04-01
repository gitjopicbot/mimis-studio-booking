-- =============================================
-- Mimi's Studio - Supabase Database Setup
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New Query)
-- =============================================

-- 1. CLIENTS TABLE
CREATE TABLE IF NOT EXISTS clients (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  remind_email BOOLEAN DEFAULT true,
  remind_sms BOOLEAN DEFAULT true,
  remind_browser BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for quick lookup by email
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);

-- 2. SERVICES TABLE
CREATE TABLE IF NOT EXISTS services (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  category TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0
);

-- 3. APPOINTMENTS TABLE
CREATE TABLE IF NOT EXISTS appointments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  appointment_date DATE NOT NULL,
  start_time INTEGER NOT NULL,        -- minutes from midnight (e.g., 660 = 11:00 AM)
  end_time INTEGER NOT NULL,          -- minutes from midnight
  total_duration INTEGER NOT NULL,    -- total minutes
  status TEXT DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
  notes TEXT,
  reminder_24h_sent BOOLEAN DEFAULT false,
  reminder_1h_sent BOOLEAN DEFAULT false,
  mimi_notified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for checking date availability
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(appointment_date, status);

-- 4. APPOINTMENT_SERVICES (many-to-many)
CREATE TABLE IF NOT EXISTS appointment_services (
  appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES services(id),
  PRIMARY KEY (appointment_id, service_id)
);

-- 5. INSERT ALL SERVICES
INSERT INTO services (name, duration_minutes, category, sort_order) VALUES
  -- Haircuts & Styling
  ('Women''s Haircut - New Style', 60, 'haircuts', 1),
  ('Women''s Haircut - Trim', 30, 'haircuts', 2),
  ('Blow Dry', 30, 'haircuts', 3),
  ('Chelation', 30, 'haircuts', 4),
  ('Men''s Cut', 30, 'haircuts', 5),
  ('Beard Trim', 30, 'haircuts', 6),
  ('Bang Trim', 30, 'haircuts', 7),
  ('Child''s Cut', 30, 'haircuts', 8),
  -- Color & Highlights
  ('Hair Color Touch-Up', 60, 'color', 9),
  ('Hair Color Brow Tint', 30, 'color', 10),
  ('Hair Color Scalp to Ends', 90, 'color', 11),
  ('Highlights Partial Short Hair', 90, 'color', 12),
  ('Highlights Partial Long Hair', 120, 'color', 13),
  ('Highlights Full Short Hair', 120, 'color', 14),
  ('Highlights Full Long Hair', 150, 'color', 15),
  -- Perms & Chemical
  ('Perm Short Hair', 120, 'perms', 16),
  ('Perm Long Hair', 150, 'perms', 17),
  ('Perm Spiral', 180, 'perms', 18),
  ('Chemical Straightening Short', 240, 'perms', 19),
  ('Chemical Straightening Long', 300, 'perms', 20),
  -- Waxing
  ('Waxing Brows', 30, 'waxing', 21),
  ('Waxing Nose Hair', 30, 'waxing', 22),
  ('Waxing Lip', 30, 'waxing', 23),
  ('Waxing Chin', 30, 'waxing', 24),
  ('Waxing Face', 30, 'waxing', 25),
  ('Waxing Under-Arm', 30, 'waxing', 26),
  ('Waxing Half-Arm', 30, 'waxing', 27),
  ('Waxing Leg-Full', 60, 'waxing', 28),
  ('Waxing Half-Leg', 30, 'waxing', 29),
  ('Waxing Bikini', 30, 'waxing', 30),
  ('Waxing Brazilian Woman', 60, 'waxing', 31),
  ('Waxing Brazilian Man', 60, 'waxing', 32),
  -- Makeup & Other
  ('Personal', 60, 'other', 33),
  ('Custom Blend Makeup', 60, 'other', 34),
  ('Other 1hr Service', 60, 'other', 35);

-- 6. ENABLE ROW LEVEL SECURITY
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;

-- 7. RLS POLICIES (allow public read for services, allow inserts for booking)
-- Services: anyone can read
CREATE POLICY "Services are viewable by everyone" ON services FOR SELECT USING (true);

-- Clients: allow insert from API, select for matching
CREATE POLICY "Allow client insert" ON clients FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow client select" ON clients FOR SELECT USING (true);
CREATE POLICY "Allow client update" ON clients FOR UPDATE USING (true);

-- Appointments: allow insert and select
CREATE POLICY "Allow appointment insert" ON appointments FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow appointment select" ON appointments FOR SELECT USING (true);
CREATE POLICY "Allow appointment update" ON appointments FOR UPDATE USING (true);

-- Appointment services: allow insert and select
CREATE POLICY "Allow appointment_services insert" ON appointment_services FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow appointment_services select" ON appointment_services FOR SELECT USING (true);
