class _AddressManageView extends View {
    constructor(session = null) {
        super('prompt');
        this.el.classList.add('address-manage');
        this._el = template('address-manage-prompt');
        this.el.appendChild(this._el);

        this.session = session;
        this.needsSelection = Boolean(session?.needs_mailbox_selection);
        this.suggestedAddress = session?.suggested_address || null;
        this.claimId = null;

        this.el.querySelectorAll('.title').forEach(e => {
            e.innerText = this.needsSelection
                ? 'Choose a mailbox address'
                : 'Manage Email Addresses';
        });
        this.el.querySelectorAll('.close').forEach(e => {
            e.addEventListener('click', this.close.bind(this));
        });

        this.buildRegisterForm();
        this.buildClaimForm();
        this.buildSuggested();
    }

    async open() {
        await super.open();
        await this.draw();
    }

    async close() {
        super.close();
        delete window.AddressManageView;
    }

    domain() {
        return this.suggestedAddress?.split('@')[1]
            || this.session?.mailboxes?.[0]?.address?.split('@')[1]
            || '';
    }

    buildRegisterForm() {
        const form = template('address-register-form');
        const domain = this.domain();
        form.querySelectorAll('.domain-suffix').forEach(e => {
            e.innerText = domain ? '@' + domain : '';
        });
        form.addEventListener('submit', this.onRegister.bind(this));
        this.el.querySelector('.register-slot').appendChild(form);
    }

    buildClaimForm() {
        const form = template('address-claim-form');
        form.addEventListener('submit', this.onClaim.bind(this));
        form.querySelector('.sendcode').addEventListener(
            'click',
            this.onSendCode.bind(this, form),
        );
        form.querySelector('.resendcode').addEventListener(
            'click',
            this.onSendCode.bind(this, form),
        );
        this.el.querySelector('.claim-slot').appendChild(form);
    }

    buildSuggested() {
        const block = this.el.querySelector('.suggested-block');
        if (!this.needsSelection || !this.suggestedAddress) return;
        block.classList.remove('hidden');
        block.querySelector('.suggested-text').innerText =
            `Your username address is taken. Use ${this.suggestedAddress} instead.`;
        block.querySelector('.accept-suggested').addEventListener(
            'click',
            this.onAcceptSuggested.bind(this),
        );
    }

    async onAcceptSuggested() {
        await set_status('Creating mailbox', 'LOAD');
        const response = await apiFetch('/v1/session/accept-suggested-mailbox', {
            method: 'POST',
        });
        if (response.ok) {
            window.location.reload();
        } else {
            const error = await response.json().catch(() => ({}));
            await set_status(
                'ERR',
                null,
                new Error(error.detail || 'Unable to create the suggested mailbox.'),
            );
        }
    }

    async onRegister(event) {
        event.preventDefault();
        const form = event.target;
        const local = form.querySelector('input[name=local]').value.trim();
        const display = form.querySelector('input[name=display]').value.trim();
        const response = await apiFetch('/v1/mailbox-registrations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                local_part: local,
                name: display || undefined,
            }),
        });
        const feedback = form.querySelector('.response');
        if (response.ok) {
            feedback.innerText = 'Submitted. Waiting for administrator approval.';
            feedback.className = 'response success';
            form.querySelector('input[name=local]').value = '';
            form.querySelector('input[name=display]').value = '';
            await this.draw();
        } else {
            const error = await response.json().catch(() => ({}));
            feedback.innerText = error.detail || 'Registration failed.';
            feedback.className = 'response err';
        }
    }

    async onSendCode(form) {
        const address = form.querySelector('input[name=address]').value.trim();
        if (!address) return;
        const response = await apiFetch('/v1/mailbox-claims', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ address }),
        });
        const feedback = form.querySelector('.response');
        if (response.ok) {
            const claim = await response.json();
            this.claimId = claim.id;
            feedback.innerText = 'Verification code sent.';
            feedback.className = 'response success';
            form.querySelector('input[name=code]').hidden = false;
            form.querySelector('.resendcode').hidden = false;
            form.querySelector('.sendcode').hidden = true;
        } else {
            const error = await response.json().catch(() => ({}));
            feedback.innerText = error.detail || 'Unable to send verification code.';
            feedback.className = 'response err';
        }
    }

    async onClaim(event) {
        event.preventDefault();
        const form = event.target;
        const code = form.querySelector('input[name=code]').value.trim();
        if (!this.claimId) {
            form.querySelector('.response').innerText =
                'Send a verification code first.';
            form.querySelector('.response').className = 'response err';
            return;
        }
        const response = await apiFetch(`/v1/mailbox-claims/${this.claimId}/verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        const feedback = form.querySelector('.response');
        if (response.ok) {
            const result = await response.json();
            if (result.mailbox) {
                await this.switchToMailbox(result.mailbox.id);
            } else {
                feedback.innerText = 'Claim verified. Completing...';
                feedback.className = 'response success';
                await this.draw();
            }
        } else {
            const error = await response.json().catch(() => ({}));
            feedback.innerText = error.detail || 'Verification failed.';
            feedback.className = 'response err';
        }
    }

    async switchToMailbox(mailboxId) {
        const selected = await apiFetch('/v1/session/select', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mailbox_id: mailboxId }),
        });
        if (selected.ok) window.location.reload();
        else await set_status('ERR', null, new Error('Unable to switch mailbox.'));
    }

    async verifyClaim(id, address) {
        const code = await prompt(
            'Verification code',
            `Enter the code sent to ${address}`,
        );
        if (!code) return;
        const response = await apiFetch(`/v1/mailbox-claims/${id}/verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        if (response.ok) {
            const result = await response.json();
            if (result.mailbox) {
                await this.switchToMailbox(result.mailbox.id);
                return;
            }
        } else {
            const error = await response.json().catch(() => ({}));
            alert(error.detail || 'Verification failed.');
        }
        await this.draw();
    }

    async draw() {
        const list = this.el.querySelector('.address_requests');
        list.replaceChildren();

        const [regResponse, claimResponse] = await Promise.all([
            apiFetch('/v1/mailbox-registrations'),
            apiFetch('/v1/mailbox-claims'),
        ]);
        const registrations = regResponse.ok
            ? (await regResponse.json()).data || []
            : [];
        const claims = claimResponse.ok ? (await claimResponse.json()).data || [] : [];

        const items = [
            ...registrations.map(r => ({
                address: r.address,
                kind: 'register',
                state: r.state,
                id: r.id,
                isClaim: false,
            })),
            ...claims.map(c => ({
                address: c.address,
                kind: 'claim',
                state: c.state,
                id: c.id,
                isClaim: true,
            })),
        ];

        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'content';
            empty.innerText = 'No requests yet';
            list.appendChild(empty);
            return;
        }

        for (const item of items) {
            const entry = template('address-request-item');
            entry.querySelector('.address').innerText = item.address;
            entry.querySelector('.kind').innerText = item.kind;
            const status = entry.querySelector('.status');
            const label = this.statusLabel(item.state);
            status.innerText = label.text;
            status.className = 'status ' + label.class;
            if (item.isClaim && item.state === 'pending_verification') {
                const verify = entry.querySelector('.verify');
                verify.hidden = false;
                verify.addEventListener('click', () =>
                    this.verifyClaim(item.id, item.address));
            }
            list.appendChild(entry);
        }
    }

    statusLabel(state) {
        switch (state) {
            case 'pending':
                return { text: 'waiting for approval', class: 'status-pending' };
            case 'approved':
                return { text: 'approved', class: 'status-approved' };
            case 'rejected':
                return { text: 'rejected', class: 'status-rejected' };
            case 'pending_verification':
                return { text: 'awaiting code', class: 'status-pending' };
            case 'verified':
                return { text: 'verified', class: 'status-verified' };
            case 'expired':
                return { text: 'expired', class: 'status-expired' };
            default:
                return { text: state, class: 'status-pending' };
        }
    }
}
