// Real IDs from the One Wash (Ternopil) Supabase project — not invented.
// If you add a second location to the platform, this file needs a rework
// (right now everything on this site assumes the single Ternopil location).

const LOCATION_ID = 'b1629a66-08aa-48ab-b6c8-ff596732d50e';

const VEHICLE_TYPES = {
  mini: '2cb0a00e-bf27-459f-975a-5dde092b46c2',
  regular: 'f577e179-cb4c-4149-bd7c-70c8ffb489dc',
  suv: '9169b213-8ccf-4674-99f3-5a70fd0d4b31',
  crossover: 'e6a8b723-8f09-49fe-a655-ff2a7663e0be',
  bus: '784d48f7-e524-44e5-9584-e5d7ca679e5c',
};

const WASH_TYPES = {
  express: { id: 'b4f1031f-a6da-4e1a-bb3d-a35c6b8042e7', name: 'Експрес', duration: 60 },
  standard: { id: '010fb41a-24a3-4663-95c1-2dc8f5d5a0a3', name: 'Стандарт', duration: 90 },
  premium: { id: '432f4e84-0bdf-4fca-a8a9-4849badd4ecd', name: 'Преміум', duration: 120 },
  chem: { id: '0985a104-3000-4c84-a1e6-0e52e5c5dd55', name: 'Хімчистка', duration: 540 },
};

const DEFAULT_DEPOSIT = 200;
const TIMEZONE = 'Europe/Kyiv';
const SLOT_STEP_MINUTES = 30;

module.exports = { LOCATION_ID, VEHICLE_TYPES, WASH_TYPES, DEFAULT_DEPOSIT, TIMEZONE, SLOT_STEP_MINUTES };
