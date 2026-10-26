# PHP adapter

## Bootstrap (composer/rector/phpstan are often absent)
```bash
command -v composer || { php -r "copy('https://getcomposer.org/installer','/tmp/ci.php');" \
  && php /tmp/ci.php --install-dir=/usr/local/bin --filename=composer; }
composer require --dev rector/rector phpstan/phpstan \
  squizlabs/php_codesniffer phpcompatibility/php-compatibility
```

## Version is declared in up to 7 places
`composer.json#require.php` · `#config.platform.php` · `composer.lock#platform.php` · `.php-version` · `.tool-versions` · `FROM php:*` stages · CI (`shivammathur/setup-php`, `php-version:`).

`config.platform.php` is the sneaky one: it makes Composer **resolve as if** on that version regardless of the real runtime. A repo can resolve for 7.4 while running 8.2.

## Extension ABI — no N-API equivalent
`ZEND_MODULE_API_NO` is a date integer (`php -i | grep "PHP API"` → e.g. `20230831` for 8.3). It changes **every minor**. Patch releases (`x.y.z`) stay binary-compatible; minors do not.

**Every compiled extension must be recompiled for a new minor.** NTS vs ZTS and debug-vs-release must also match. The failure mode is worse than Node's: the engine refuses to load the `.so` and **the process does not boot**.

```bash
diff <(php -m | grep -v '^\[' | sort) <(docker run --rm NEWIMG php -m | grep -v '^\[' | sort)
```
Anything present on old and missing on new is a boot-time failure waiting to happen.

## Dependency compatibility — Composer answers this directly
```bash
composer prohibits php:8.4        # names exactly which packages block the target
composer check-platform-reqs      # validates PHP *and extension* versions
composer update --dry-run --with-all-dependencies
composer why-not <pkg> <version>
```
`--ignore-platform-req=php+` ignores only the **upper** bound — fine for a trial resolve, never commit it.

**Never set `config.platform-check: false`** to silence errors. It defers a resolvable build error into a runtime crash.

## Rector does 80–90% mechanically
```bash
composer require --dev rector/rector
vendor/bin/rector process --dry-run     # ALWAYS dry-run and read the diff first
vendor/bin/rector process               # then apply
```
```php
// rector.php
use Rector\Set\ValueObject\LevelSetList;
return RectorConfig::configure()
    ->withPaths([__DIR__.'/src'])
    ->withSets([LevelSetList::UP_TO_PHP_84]);   // _83 / _84 / _85
```
Two rules that matter:
- **Rector reads the minimum from `composer.json`.** If `require.php` still says `^8.1` it will not fully apply 8.4 rules. Bump the manifest first.
- **One level at a time**: `UP_TO_PHP_82` → test → commit → `UP_TO_PHP_83` → test → commit. Jumping to the top makes failures unattributable.

Rector will not make semantic decisions (serialization strategy, wrong enum comparison). It clears boilerplate so the human-judgement list shrinks to a handful.

## Static detection — use both, never either alone
```bash
vendor/bin/phpcs -p . --standard=PHPCompatibility --runtime-set testVersion 8.3-8.4
vendor/bin/phpstan analyse --level=5 src/     # with parameters.phpVersion: 80400
```
PHPCompatibility has **no cross-file awareness and no type inference** — it misses PHP 8 type-system breakage. PHPStan catches typed properties, union types, stricter type rules. Together they cover what either misses.

## Breaking changes
- `UPGRADING` and `UPGRADING.INTERNALS` in `php/php-src` for the target branch — canonical and exhaustive
- `https://www.php.net/manual/en/migration<XY>.incompatible.php`
- `https://wiki.php.net/rfc` for the reasoning

## Deprecations are silent by default
`E_DEPRECATED` (8192) is **not** in PHP's default `error_reporting`. During tests:
```php
error_reporting(E_ALL);
set_error_handler(function ($no, $str, $file, $line) {
    if ($no === E_DEPRECATED) throw new ErrorException($str, 0, $no, $file, $line);
    return false;
});
```

## Runtime CVEs — no curated database
PHP has no equivalent of `nodejs/security-wg`. NVD CPE (`cpe:2.3:a:php:php:<version>`) returns historical CVEs for the product, not "unpatched at this version". **Cannot support a hard numeric gate.** Gate on EOL/support status and `composer audit` instead; present runtime CVEs as advisory and supplement with the distro tracker (Debian/Sury, Alpine) for the actual build in use.
