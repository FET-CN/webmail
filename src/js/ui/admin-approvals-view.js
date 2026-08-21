class _AdminApprovalsView extends View {
    constructor() {
        super('prompt');
        this.el.classList.add('admin-approvals');
        this._el = template('admin-approvals-prompt');
        this.el.appendChild(this._el);

        this.el.querySelectorAll('.title').forEach(e => {
            e.innerText = 'Approvals';
        });
        this.el.querySelectorAll('.close').forEach(e => {
            e.addEventListener('click', this.close.bind(this));
        });
    }

    async open() {
        await super.open();
        await this.draw();
    }

    async close() {
        super.close();
        delete window.AdminApprovalsView;
    }

    async draw() {
        const list = this.el.querySelector('.approval_items');
        list.replaceChildren();

        const response = await apiFetch(
            '/v1/admin/mailbox-registrations?state=pending',
        );
        if (!response.ok) {
            const empty = document.createElement('div');
            empty.className = 'content';
            empty.innerText = 'Unable to load approvals.';
            list.appendChild(empty);
            return;
        }
        const requests = (await response.json()).data || [];
        if (!requests.length) {
            const empty = document.createElement('div');
            empty.className = 'content';
            empty.innerText = 'No pending approvals';
            list.appendChild(empty);
            return;
        }
        for (const request of requests) {
            const entry = template('admin-approval-item');
            entry.querySelector('.address').innerText = request.address;
            entry.querySelector('.requester').innerText =
                request.requester_username || request.userId;
            entry.querySelector('.date').innerText = request.createdAt;
            entry.querySelector('.approve').addEventListener('click', () =>
                this.onApprove(request.id, entry));
            entry.querySelector('.reject').addEventListener('click', () =>
                this.onReject(request.id, entry));
            list.appendChild(entry);
        }
    }

    async onApprove(id, entry) {
        await set_status('Approving registration', 'LOAD');
        const response = await apiFetch(
            `/v1/admin/mailbox-registrations/${id}/approve`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            },
        );
        if (response.ok) {
            entry.remove();
            window.dispatchEvent(new CustomEvent('address-requests-changed'));
            await set_status('OK');
        } else {
            const error = await response.json().catch(() => ({}));
            alert(error.detail || 'Approval failed.');
            await set_status('ERR', null, new Error(error.detail || 'Approval failed.'));
        }
        await this.draw();
    }

    async onReject(id, entry) {
        if (!confirm('Reject this registration request?')) return;
        await set_status('Rejecting registration', 'LOAD');
        const response = await apiFetch(
            `/v1/admin/mailbox-registrations/${id}/reject`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            },
        );
        if (response.ok) {
            entry.remove();
            window.dispatchEvent(new CustomEvent('address-requests-changed'));
            await set_status('OK');
        } else {
            const error = await response.json().catch(() => ({}));
            alert(error.detail || 'Rejection failed.');
            await set_status('ERR', null, new Error(error.detail || 'Rejection failed.'));
        }
        await this.draw();
    }
}
