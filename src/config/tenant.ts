/**
 * Tenant (workspace) identity helpers.
 *
 * A Tenant is the account / workspace identity. It is provisioned by the user at
 * onboarding (today via `cr init`, which writes `config.tenant`; later from an
 * account record when ACL/accounts exist). The slug is the stable key, derived
 * from the human-facing name.
 */

/** Canonical, URL-safe slug for a workspace name. Diacritics stripped, punctuation collapsed to '-'. */
export function slugifyTenant(name: string): string {
    return name
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
