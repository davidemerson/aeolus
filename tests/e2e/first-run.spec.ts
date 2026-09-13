import { expect, test } from '@playwright/test';

// The way a real person gets into a real instance, driven through the UI:
// an administrator creates the account, hands over the generated passphrase,
// and the new user is made to replace it before they can do anything.
//
// Everything here goes through the shipped screens. The one shortcut is the
// administrator's own session, which comes from the dev endpoint — the very
// first administrator is created at boot by the api's launcher, which this
// harness does not run.

const ADMIN_EMAIL = 'admin-first-run@example.com';
const NEW_USER_EMAIL = 'newcomer@example.com';
const CHOSEN_PASSPHRASE = 'harbour pumice fennel drawbridge kettle';

test.describe('first run', () => {
  test('an admin creates an account and its owner is forced to choose a passphrase', async ({
    browser,
    request,
  }) => {
    const adminCreate = await request.post('/api/dev/users', {
      data: { email: ADMIN_EMAIL, name: 'Admin', isAdmin: true },
    });
    expect(adminCreate.status(), 'create admin').toBe(201);
    const admin = (await adminCreate.json()) as { id: string };

    const adminContext = await browser.newContext({ baseURL: 'http://localhost:5173' });
    const adminSession = await adminContext.request.post('/api/dev/sessions', {
      data: { userId: admin.id },
    });
    expect(adminSession.status(), 'admin dev session').toBe(201);
    const adminState = await adminContext.request.storageState();
    if (adminState.cookies.length > 0) await adminContext.addCookies(adminState.cookies);

    let issuedPassphrase: string;
    const adminPage = await adminContext.newPage();
    try {
      // 1. The admin adds the account and is shown the passphrase once.
      await adminPage.goto('/admin/users');
      await adminPage.getByTestId('admin-users-new-email').fill(NEW_USER_EMAIL);
      await adminPage.getByTestId('admin-users-new-name').fill('Newcomer');
      await adminPage.getByTestId('admin-users-create').click();

      const issued = adminPage.getByTestId('admin-users-issued-passphrase');
      await expect(issued).toBeVisible();
      issuedPassphrase = ((await issued.textContent()) ?? '').trim();
      // Six words from the wordlist, which is what the generator produces.
      expect(issuedPassphrase.split(' ')).toHaveLength(6);

      await adminPage.getByTestId('admin-users-issued-dismiss').click();
      await expect(issued).toBeHidden();
    } finally {
      await adminContext.close();
    }

    // 2. The new user signs in with it, in a browser that has never seen this
    //    instance before.
    const userContext = await browser.newContext({ baseURL: 'http://localhost:5173' });
    const userPage = await userContext.newPage();
    try {
      await userPage.goto('/login');
      await userPage.getByTestId('login-email').fill(NEW_USER_EMAIL);
      await userPage.getByTestId('login-passphrase').fill(issuedPassphrase);
      await userPage.getByTestId('login-submit').click();

      // 3. Straight to setup, not to the workspace. The current passphrase is
      //    not asked for: the sign-in just proved it.
      await userPage.waitForURL(/\/passphrase$/);
      await expect(userPage.getByTestId('passphrase-form')).toBeVisible();
      await expect(userPage.getByTestId('passphrase-current')).toHaveCount(0);

      // 4. A weak choice is refused, with the reason on screen, and does not
      //    let them past.
      await userPage.getByTestId('passphrase-next').fill('password');
      await userPage.getByTestId('passphrase-confirm').fill('password');
      await userPage.getByTestId('passphrase-submit').click();
      await expect(userPage.getByTestId('passphrase-problems')).toBeVisible();
      expect(new URL(userPage.url()).pathname).toBe('/passphrase');

      // 5. A real one is accepted and lands them in the workspace.
      await userPage.getByTestId('passphrase-next').fill(CHOSEN_PASSPHRASE);
      await userPage.getByTestId('passphrase-confirm').fill(CHOSEN_PASSPHRASE);
      await userPage.getByTestId('passphrase-submit').click();
      await userPage.waitForURL(/\/docs$/);
      await expect(userPage.getByTestId('topbar-user')).toHaveText('Newcomer');
    } finally {
      await userContext.close();
    }

    // 6. The generated credential is spent; the chosen one works.
    const stale = await request.post('/api/auth/login', {
      data: { email: NEW_USER_EMAIL, passphrase: issuedPassphrase },
      failOnStatusCode: false,
    });
    expect(stale.status(), 'the printed passphrase no longer signs in').toBe(401);

    const fresh = await request.post('/api/auth/login', {
      data: { email: NEW_USER_EMAIL, passphrase: CHOSEN_PASSPHRASE },
    });
    expect(fresh.status()).toBe(200);
    expect((await fresh.json()) as { must_set_passphrase: boolean }).toMatchObject({
      must_set_passphrase: false,
    });
  });
});
