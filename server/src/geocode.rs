//! Offline geocoding against bundled GeoNames data.
//!
//! Parses `cities15000.txt` (all cities with population >= 15k, ~27k entries) and
//! `countryInfo.txt` (~250 countries) at startup into in-memory lookup tables.
//!
//! Matching (CLAUDE.md Rule 15, best-effort):
//! 1. Normalize free-text location (lowercase, strip extra whitespace).
//! 2. Try aliases (SF → San Francisco, NYC → New York, KR → South Korea, …).
//! 3. Split on commas; try each part longest-first.
//! 4. Each part: exact match against city → country by name → country by ISO code.
//! 5. Return first hit; no match drops the globe pulse (counter still records the star).
//!
//! Data is licensed CC BY 4.0 (GeoNames). See `server/data/geonames/`.

use std::collections::HashMap;

const CITIES_RAW: &str = include_str!("../data/geonames/cities15000.txt");
const COUNTRY_INFO_RAW: &str = include_str!("../data/geonames/countryInfo.txt");

#[derive(Clone, Copy, Debug)]
pub struct Coords {
    pub lat: f64,
    pub lng: f64,
}

pub struct Geocoder {
    /// ascii city name (lowercase) → coords (most populous wins on ties)
    cities: HashMap<String, Coords>,
    /// country name (lowercase) → coords (capital city)
    countries_by_name: HashMap<String, Coords>,
    /// ISO2/ISO3 code (uppercase) → coords (capital)
    countries_by_iso: HashMap<String, Coords>,
}

impl Geocoder {
    pub fn build() -> Self {
        // Parse cities first. Keep the most populous entry per asciiname.
        let mut cities_pop: HashMap<String, (Coords, u64, String)> = HashMap::new();
        let mut capital_by_iso: HashMap<String, Coords> = HashMap::new();

        for line in CITIES_RAW.lines() {
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() < 15 {
                continue;
            }
            let asciiname = fields[2].trim();
            if asciiname.is_empty() {
                continue;
            }
            let Ok(lat) = fields[4].parse::<f64>() else { continue };
            let Ok(lng) = fields[5].parse::<f64>() else { continue };
            let feature_code = fields[7];
            let country_code = fields[8].to_uppercase();
            let population: u64 = fields[14].parse().unwrap_or(0);
            let coords = Coords { lat, lng };

            // City index
            let key = asciiname.to_lowercase();
            match cities_pop.get(&key) {
                Some(&(_, pop, _)) if pop >= population => {}
                _ => {
                    cities_pop.insert(key, (coords, population, country_code.clone()));
                }
            }

            // Capture capital cities (feature_code PPLC) for country fallbacks
            if feature_code == "PPLC" && !country_code.is_empty() {
                capital_by_iso.insert(country_code, coords);
            }
        }

        let cities: HashMap<String, Coords> =
            cities_pop.into_iter().map(|(k, (c, _, _))| (k, c)).collect();

        // Parse country info: ISO, ISO3, Country name, Capital. Lines starting with # are comments.
        let mut countries_by_name: HashMap<String, Coords> = HashMap::new();
        let mut countries_by_iso: HashMap<String, Coords> = HashMap::new();

        for line in COUNTRY_INFO_RAW.lines() {
            if line.starts_with('#') || line.trim().is_empty() {
                continue;
            }
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() < 6 {
                continue;
            }
            let iso2 = fields[0].to_uppercase();
            let iso3 = fields[1].to_uppercase();
            let country_name = fields[4].trim().to_lowercase();

            if let Some(&coords) = capital_by_iso.get(&iso2) {
                if !country_name.is_empty() {
                    countries_by_name.insert(country_name.clone(), coords);
                }
                if !iso2.is_empty() {
                    countries_by_iso.insert(iso2.clone(), coords);
                }
                if !iso3.is_empty() {
                    countries_by_iso.insert(iso3, coords);
                }
            }
        }

        tracing::info!(
            cities = cities.len(),
            countries_by_name = countries_by_name.len(),
            countries_by_iso = countries_by_iso.len(),
            "geocoder loaded"
        );

        Self { cities, countries_by_name, countries_by_iso }
    }

    pub fn lookup(&self, raw: &str) -> Option<Coords> {
        let cleaned = raw.trim().to_lowercase();
        if cleaned.is_empty() {
            return None;
        }

        // Split on commas/pipes/slashes and try each part longest-first.
        let mut parts: Vec<String> = cleaned
            .split(|c: char| matches!(c, ',' | '|' | '/'))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        parts.sort_by_key(|p| std::cmp::Reverse(p.len()));

        for part in &parts {
            if let Some(c) = self.match_part(part) {
                return Some(c);
            }
        }
        self.match_part(&cleaned)
    }

    fn match_part(&self, part: &str) -> Option<Coords> {
        let normalized = alias(part);
        if let Some(&c) = self.cities.get(normalized.as_ref()) {
            return Some(c);
        }
        if let Some(&c) = self.countries_by_name.get(normalized.as_ref()) {
            return Some(c);
        }
        if normalized.len() == 2 || normalized.len() == 3 {
            let upper = normalized.to_uppercase();
            if let Some(&c) = self.countries_by_iso.get(&upper) {
                return Some(c);
            }
        }
        None
    }
}

fn alias(part: &str) -> std::borrow::Cow<'_, str> {
    match part {
        "sf" => "san francisco".into(),
        "nyc" => "new york".into(),
        "la" => "los angeles".into(),
        "uk" | "u.k." => "united kingdom".into(),
        "usa" | "u.s.a." | "us" | "u.s." => "united states".into(),
        "kr" => "south korea".into(),
        "sg" => "singapore".into(),
        "hk" => "hong kong".into(),
        "jp" => "japan".into(),
        "cn" => "china".into(),
        "de" => "germany".into(),
        "fr" => "france".into(),
        other => other.into(),
    }
}
