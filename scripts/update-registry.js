#!/usr/bin/env node

/**
 * Script to update the extension registry
 * Scans all directories and updates registry.json
 *
 *   node scripts/update-registry.js               # this repository: its registry.json, from its own tree
 *   node scripts/update-registry.js --root <dir>  # <dir>/registry.json, from <dir>/registry and <dir>/templates
 *
 * --root lets the release regenerate the catalog in a checkout where it has placed the published copy first, and
 * lets the tests run the generator on a workspace outside the repository. An option it does not know, or --root
 * with no folder, fails before anything is read or written.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { stabilizeRegistry } from './registry-stability.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { values } = parseArgs({ options: { root: { type: 'string' } } });
if (values.root === '') {
  console.error('update-registry: --root names no folder');
  process.exit(1);
}
const rootDir = values.root === undefined ? path.join(__dirname, '..') : path.resolve(values.root);
const registryPath = path.join(rootDir, 'registry.json');
const leftOut = [];

/**
 * Whether a package is private. npm never serves a private package, and a consumer installs a catalog entry by its
 * package name and version, so a private package gets no entry; the run's log names each one left out.
 * @param {{ name?: string, private?: boolean }} packageJson
 */
function leftOutAsPrivate(packageJson) {
  if (packageJson.private !== true) return false;
  leftOut.push(packageJson.name);
  return true;
}

function listSubdirectories(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function scanExtensions() {
  const curatedDir = path.join(rootDir, 'registry', 'curated');
  const communityDir = path.join(rootDir, 'registry', 'community');

  const registry = {
    version: '1.0.0',
    updated: new Date().toISOString(),
    categories: {
      templates: [],
      curated: listSubdirectories(curatedDir),
      community: listSubdirectories(communityDir)
    },
    extensions: {
      curated: [],
      community: [],
      templates: []
    },
    stats: {
      totalExtensions: 0,
      curatedCount: 0,
      communityCount: 0,
      templateCount: 0,
      totalDownloads: 0
    }
  };
  
  // Scan templates
  const templatesDir = path.join(rootDir, 'templates');
  if (fs.existsSync(templatesDir)) {
    fs.readdirSync(templatesDir).forEach(template => {
      const templatePath = path.join(templatesDir, template);
      const packageJsonPath = path.join(templatePath, 'package.json');
      
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        if (leftOutAsPrivate(packageJson)) return;
        registry.categories.templates.push(template);
        registry.extensions.templates.push({
          id: `com.framers.template.${template}`,
          name: packageJson.description || template,
          package: packageJson.name,
          version: packageJson.version,
          path: `templates/${template}`,
          description: packageJson.description,
          repository: `https://github.com/framerslab/agentos-extensions/tree/master/templates/${template}`
        });
        registry.stats.templateCount++;
      }
    });
  }
  
  // Scan curated extensions
  if (fs.existsSync(curatedDir)) {
    registry.categories.curated.forEach(category => {
      const categoryPath = path.join(curatedDir, category);
      if (fs.existsSync(categoryPath)) {
        fs.readdirSync(categoryPath).forEach(extension => {
          const extPath = path.join(categoryPath, extension);
          const packageJsonPath = path.join(extPath, 'package.json');
          const manifestPath = path.join(extPath, 'manifest.json');
          
          if (fs.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            if (leftOutAsPrivate(packageJson)) return;
            const manifest = fs.existsSync(manifestPath) 
              ? JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
              : {};
            
            registry.extensions.curated.push({
              id: manifest.id || `com.framers.${category}.${extension}`,
              name: manifest.name || packageJson.description,
              package: packageJson.name,
              version: packageJson.version,
              category,
              path: `registry/curated/${category}/${extension}`,
              description: manifest.description || packageJson.description,
              author: manifest.author || packageJson.author,
              features: manifest.features || [],
              tools: manifest.extensions?.map(e => e.id) || [],
              keywords: manifest.keywords || packageJson.keywords || [],
              npm: `https://www.npmjs.com/package/${packageJson.name}`,
              repository: `https://github.com/framerslab/agentos-extensions/tree/master/registry/curated/${category}/${extension}`,
              verified: true,
              // Verified curated extensions should carry verification metadata
              // so clients can explain the "verified" designation.
              verifiedAt: registry.updated,
              verificationChecklistVersion: registry.version,
              downloads: 0
            });
            registry.stats.curatedCount++;
          }
        });
      }
    });
  }
  
  // Scan community extensions
  if (fs.existsSync(communityDir)) {
    registry.categories.community.forEach(category => {
      const categoryPath = path.join(communityDir, category);
      if (fs.existsSync(categoryPath)) {
        fs.readdirSync(categoryPath).forEach(extension => {
          const extPath = path.join(categoryPath, extension);
          const packageJsonPath = path.join(extPath, 'package.json');
          const manifestPath = path.join(extPath, 'manifest.json');
          
          if (fs.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            if (leftOutAsPrivate(packageJson)) return;
            const manifest = fs.existsSync(manifestPath) 
              ? JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
              : {};
            
            registry.extensions.community.push({
              id: manifest.id || `com.community.${category}.${extension}`,
              name: manifest.name || packageJson.description,
              package: packageJson.name,
              version: packageJson.version,
              category,
              path: `registry/community/${category}/${extension}`,
              description: manifest.description || packageJson.description,
              author: manifest.author || packageJson.author,
              keywords: manifest.keywords || packageJson.keywords || [],
              npm: `https://www.npmjs.com/package/${packageJson.name}`,
              repository: `https://github.com/framerslab/agentos-extensions/tree/master/registry/community/${category}/${extension}`,
              downloads: 0
            });
            registry.stats.communityCount++;
          }
        });
      }
    });
  }
  
  // A category whose folder lists no entry (its every package private, or none its own, as the flat auth library's)
  // is no category a consumer can install from, so it is left out with its packages.
  for (const group of ['curated', 'community']) {
    registry.categories[group] = registry.categories[group].filter((category) =>
      registry.extensions[group].some((entry) => entry.category === category),
    );
  }

  registry.stats.totalExtensions = 
    registry.stats.curatedCount + 
    registry.stats.communityCount +
    registry.stats.templateCount;
  
  return registry;
}

function updateRegistry() {
  // The existing registry's timestamps stay where nothing else changed, so an unchanged tree regenerates that file
  // byte for byte and the release's comparison of the regenerated catalog with the published one holds. git tracks no
  // copy: the existing file is the published catalog the release places at <root>/registry.json before it runs this,
  // or an earlier build's output. One that does not parse is regenerated whole, with fresh timestamps, instead of
  // stopping the build.
  let previous = null;
  if (fs.existsSync(registryPath)) {
    try {
      previous = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    } catch (error) {
      console.warn(`registry.json did not parse (${error.message}); regenerating it without its timestamps`);
    }
  }
  const registry = stabilizeRegistry(previous, scanExtensions());
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  
  console.log('✅ Registry updated:');
  console.log(`  - Curated: ${registry.stats.curatedCount}`);
  console.log(`  - Community: ${registry.stats.communityCount}`);
  console.log(`  - Templates: ${registry.stats.templateCount}`);
  console.log(`  - Total: ${registry.stats.totalExtensions}`);
  for (const name of leftOut) console.log(`  - Left out ${name}: its package.json is private, so npm never serves it`);
}

updateRegistry();
