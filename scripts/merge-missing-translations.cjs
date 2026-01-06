const fs = require('fs');
const path = require('path');

/**
 * Converts flat object with dot notation keys to nested structure
 * @param {Record<string, any>} flat - Flat object with dot notation keys
 * @returns {Record<string, any>} Nested object
 */
function unflatten(flat) {
  const result = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }
  return result;
}

/**
 * Deep merges source object into target object
 * Only adds keys that don't exist in target (doesn't overwrite existing values)
 * @param {Record<string, any>} target - Target object to merge into
 * @param {Record<string, any>} source - Source object to merge from
 * @returns {Record<string, any>} Merged object
 */
function deepMerge(target, source) {
  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && source[key].constructor === Object) {
        if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key]) || target[key].constructor !== Object) {
          target[key] = {};
        }
        deepMerge(target[key], source[key]);
      } else if (!target.hasOwnProperty(key)) {
        target[key] = source[key];
      }
    }
  }
  return target;
}

const LOCALES_DIR = './src/locales';
const locales = ['ar', 'be', 'de', 'en-GB', 'es', 'fr', 'hy', 'it', 'ja', 'nb', 'pl', 'pt', 'ru', 'tr', 'uk', 'zh'];

let totalProcessed = 0;
const results = [];

console.log('Merging missing translations into common.json files...\n');

for (const locale of locales) {
  const missingPath = path.join(LOCALES_DIR, locale, 'missing.json');
  const commonPath = path.join(LOCALES_DIR, locale, 'common.json');
  
  if (!fs.existsSync(missingPath)) {
    console.log(`[${locale}] No missing.json, skipping`);
    continue;
  }
  
  if (!fs.existsSync(commonPath)) {
    console.log(`[${locale}] No common.json, skipping`);
    continue;
  }
  
  try {
    const missingContent = fs.readFileSync(missingPath, 'utf8').trim();
    
    // Skip empty files or files with only {}
    if (!missingContent || missingContent === '{}' || missingContent === '{\n}') {
      console.log(`[${locale}] Empty missing.json, skipping`);
      continue;
    }
    
    const missing = JSON.parse(missingContent);
    const missingKeys = Object.keys(missing);
    
    if (missingKeys.length === 0) {
      console.log(`[${locale}] No keys in missing.json, skipping`);
      continue;
    }
    
    const common = JSON.parse(fs.readFileSync(commonPath, 'utf8'));
    const nested = unflatten(missing);
    const merged = deepMerge(JSON.parse(JSON.stringify(common)), nested);
    fs.writeFileSync(commonPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    
    console.log(`[${locale}] ✓ Processed ${missingKeys.length} keys`);
    totalProcessed += missingKeys.length;
    results.push({ locale, count: missingKeys.length });
  } catch (error) {
    console.error(`[${locale}] ✗ Error:`, error.message);
  }
}

console.log(`\n✅ Done! Total keys processed: ${totalProcessed}`);
if (results.length > 0) {
  console.log('\nSummary:');
  results.forEach(({ locale, count }) => {
    console.log(`  ${locale}: ${count} keys`);
  });
}







