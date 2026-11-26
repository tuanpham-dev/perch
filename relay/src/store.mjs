// The relay's storage: groups, machines (public keys and sealed blobs only),
// invites (public half of the enrolment key only), removal records and re-key
// packages. Nothing here can read a machine name, a group secret or an invite
// secret, because the relay is never given them.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL DEFAULT 'key',
  owner_id TEXT,
  epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS machines (
  id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  sign_pub TEXT NOT NULL,
  dh_pub TEXT NOT NULL,
  label TEXT,
  last_seen INTEGER NOT NULL,
  profile TEXT,
  profile_epoch INTEGER,
  status TEXT NOT NULL,
  invite_id TEXT,
  PRIMARY KEY (group_id, id)
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  enrol_pub TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  uses_left INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS removals (
  group_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (group_id, machine_id, epoch)
);
CREATE TABLE IF NOT EXISTS rekey_packages (
  group_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  record TEXT NOT NULL,
  sealed TEXT NOT NULL,
  PRIMARY KEY (group_id, machine_id, epoch)
);
`

const machineRow = (r) =>
  r && {
    id: r.id,
    groupId: r.group_id,
    signPub: r.sign_pub,
    dhPub: r.dh_pub,
    label: r.label,
    lastSeen: r.last_seen,
    profile: r.profile,
    profileEpoch: r.profile_epoch,
    status: r.status,
    inviteId: r.invite_id,
  }

const inviteRow = (r) =>
  r && {
    id: r.id,
    groupId: r.group_id,
    enrolPub: r.enrol_pub,
    expiresAt: r.expires_at,
    usesLeft: r.uses_left,
    createdBy: r.created_by,
    createdAt: r.created_at,
    status: r.status,
  }

export function openStore(dataDir, { now = Date.now } = {}) {
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(join(dataDir, 'relay.sqlite'))
  db.exec('PRAGMA journal_mode = WAL')
  const { user_version: found } = db.prepare('PRAGMA user_version').get()
  if (found > SCHEMA_VERSION) {
    db.close()
    throw new Error(
      `This data folder was written by a newer relay (schema ${found}, this relay understands ${SCHEMA_VERSION}). Update the relay.`,
    )
  }
  db.exec(SCHEMA)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)

  const q = (sql) => db.prepare(sql)
  const stmts = {
    group: q('SELECT * FROM groups WHERE id = ?'),
    groups: q('SELECT * FROM groups ORDER BY created_at, id'),
    insertGroup: q("INSERT INTO groups (id, owner_kind, owner_id, epoch, created_at) VALUES (?, 'key', NULL, 1, ?)"),
    machine: q('SELECT * FROM machines WHERE group_id = ? AND id = ?'),
    machines: q("SELECT * FROM machines WHERE group_id = ? AND status != 'pending' ORDER BY rowid"),
    insertMachine: q(
      'INSERT INTO machines (id, group_id, sign_pub, dh_pub, label, last_seen, status, invite_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    memberCount: q("SELECT COUNT(*) AS n FROM machines WHERE group_id = ? AND status IN ('member', 'blocked')"),
    invite: q('SELECT * FROM invites WHERE id = ?'),
    insertInvite: q(
      "INSERT INTO invites (id, group_id, enrol_pub, expires_at, uses_left, created_by, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')",
    ),
    activeInvites: q(
      "SELECT * FROM invites WHERE group_id = ? AND status = 'active' AND uses_left > 0 AND expires_at > ? ORDER BY created_at, rowid",
    ),
    setInviteStatus: q("UPDATE invites SET status = ? WHERE id = ? AND group_id = ? AND status = 'active'"),
    cancelInvites: q("UPDATE invites SET status = 'cancelled' WHERE group_id = ? AND status = 'active'"),
    promote: q("UPDATE machines SET status = 'member', invite_id = NULL WHERE group_id = ? AND id = ? AND status = 'pending'"),
    useInvite: q('UPDATE invites SET uses_left = uses_left - 1 WHERE id = ?'),
    finishInvite: q("UPDATE invites SET status = 'used' WHERE id = ? AND uses_left <= 0"),
    setEpoch: q('UPDATE groups SET epoch = ? WHERE id = ? AND epoch = ?'),
    setStatus: q('UPDATE machines SET status = ? WHERE group_id = ? AND id = ?'),
    insertRemoval: q('INSERT INTO removals (group_id, machine_id, epoch, record) VALUES (?, ?, ?, ?)'),
    insertPackage: q(
      'INSERT OR REPLACE INTO rekey_packages (group_id, machine_id, epoch, record, sealed) VALUES (?, ?, ?, ?, ?)',
    ),
    packagesFor: q('SELECT epoch, record, sealed FROM rekey_packages WHERE group_id = ? AND machine_id = ? ORDER BY epoch'),
    deletePackages: q('DELETE FROM rekey_packages WHERE group_id = ? AND machine_id = ? AND epoch <= ?'),
    latestRemoval: q('SELECT record FROM removals WHERE group_id = ? AND machine_id = ? ORDER BY epoch DESC LIMIT 1'),
    setProfile: q('UPDATE machines SET profile = ?, profile_epoch = ? WHERE group_id = ? AND id = ?'),
    setLabel: q('UPDATE machines SET label = ? WHERE group_id = ? AND id = ?'),
    touch: q('UPDATE machines SET last_seen = ? WHERE group_id = ? AND id = ?'),
    deleteMachine: q('DELETE FROM machines WHERE group_id = ? AND id = ?'),
    deleteMachinePackages: q('DELETE FROM rekey_packages WHERE group_id = ? AND machine_id = ?'),
    deletePending: q("DELETE FROM machines WHERE group_id = ? AND status = 'pending'"),
    deleteAllPending: q("DELETE FROM machines WHERE status = 'pending'"),
  }

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      db.exec('COMMIT')
      return out
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  const store = {
    close() {
      db.close()
    },

    // Groups and machines
    group(id) {
      const r = stmts.group.get(id)
      return r && { id: r.id, ownerKind: r.owner_kind, ownerId: r.owner_id, epoch: r.epoch, createdAt: r.created_at }
    },
    groups() {
      return stmts.groups.all().map((r) => ({
        id: r.id,
        ownerKind: r.owner_kind,
        ownerId: r.owner_id,
        epoch: r.epoch,
        createdAt: r.created_at,
      }))
    },
    createGroup(groupId, machine) {
      return transaction(() => {
        const t = now()
        stmts.insertGroup.run(groupId, t)
        stmts.insertMachine.run(machine.id, groupId, machine.signPub, machine.dhPub, machine.label ?? null, t, 'member', null)
      })
    },
    machine(groupId, id) {
      return machineRow(stmts.machine.get(groupId, id))
    },
    // Members and blocked machines, never pending joiners.
    machines(groupId) {
      return stmts.machines.all(groupId).map(machineRow)
    },
    memberCount(groupId) {
      return stmts.memberCount.get(groupId).n
    },
    addPending(groupId, machine, inviteId) {
      stmts.insertMachine.run(machine.id, groupId, machine.signPub, machine.dhPub, null, now(), 'pending', inviteId)
    },
    deletePending(groupId) {
      stmts.deletePending.run(groupId)
    },
    deleteAllPending() {
      stmts.deleteAllPending.run()
    },
    deleteMachine(groupId, id) {
      stmts.deleteMachinePackages.run(groupId, id)
      stmts.deleteMachine.run(groupId, id)
    },
    setProfile(groupId, id, blob, epoch) {
      stmts.setProfile.run(blob, epoch, groupId, id)
      stmts.touch.run(now(), groupId, id)
    },
    setLabel(groupId, id, label) {
      stmts.setLabel.run(label || null, groupId, id)
    },
    touch(groupId, id, at = now()) {
      stmts.touch.run(at, groupId, id)
    },
    block(groupId, id) {
      stmts.setStatus.run('blocked', groupId, id)
    },

    // Invites
    invite(id) {
      return inviteRow(stmts.invite.get(id))
    },
    createInvite({ id, groupId, enrolPub, expiresAt, uses, createdBy }) {
      stmts.insertInvite.run(id, groupId, enrolPub, expiresAt, uses, createdBy, now())
    },
    // Returns true when an active invite of that group was revoked.
    revokeInvite(groupId, id) {
      return Number(stmts.setInviteStatus.run('revoked', id, groupId).changes) > 0
    },
    cancelInvites(groupId) {
      stmts.cancelInvites.run(groupId)
    },
    activeInvites(groupId, at = now()) {
      return stmts.activeInvites.all(groupId, at).map(inviteRow)
    },

    // Compare-and-set: the machine must still be pending on this invite, the
    // invite must have a use left and be live, and the group must still be at
    // `epoch`. Returns { ok: true } or { ok: false, reason }.
    admit({ groupId, machineId, inviteId, epoch, at = now(), maxMembers = Infinity }) {
      return transaction(() => {
        const group = stmts.group.get(groupId)
        const machine = stmts.machine.get(groupId, machineId)
        if (!group || !machine || machine.status !== 'pending' || machine.invite_id !== inviteId) {
          return { ok: false, reason: 'not-pending' }
        }
        const invite = stmts.invite.get(inviteId)
        if (!invite || invite.group_id !== groupId) return { ok: false, reason: 'unknown' }
        if (invite.status === 'revoked' || invite.status === 'cancelled') return { ok: false, reason: invite.status }
        if (invite.status === 'used' || invite.uses_left <= 0) return { ok: false, reason: 'used' }
        if (invite.expires_at <= at) return { ok: false, reason: 'expired' }
        if (group.epoch !== epoch) return { ok: false, reason: 'epoch' }
        if (stmts.memberCount.get(groupId).n >= maxMembers) return { ok: false, reason: 'group-full' }
        stmts.promote.run(groupId, machineId)
        stmts.useInvite.run(inviteId)
        stmts.finishInvite.run(inviteId)
        return { ok: true }
      })
    },

    // Removal with an epoch compare-and-set. In one transaction: the machine
    // becomes 'removed', the record and packages are stored, every active invite
    // is cancelled and the epoch moves to record.epoch. `packages` maps
    // machine id to sealed text. Returns { ok: true, epoch } or
    // { ok: false, reason: 'epoch-conflict', epoch } / { ok: false, reason: 'not-member' }.
    remove({ groupId, removedId, fromEpoch, record, packages }) {
      return transaction(() => {
        const group = stmts.group.get(groupId)
        if (!group) return { ok: false, reason: 'no-group', epoch: 0 }
        if (group.epoch !== fromEpoch) return { ok: false, reason: 'epoch-conflict', epoch: group.epoch }
        const target = stmts.machine.get(groupId, removedId)
        if (!target || (target.status !== 'member' && target.status !== 'blocked')) {
          return { ok: false, reason: 'not-member', epoch: group.epoch }
        }
        const newEpoch = fromEpoch + 1
        const text = JSON.stringify(record)
        stmts.setEpoch.run(newEpoch, groupId, fromEpoch)
        stmts.setStatus.run('removed', groupId, removedId)
        stmts.insertRemoval.run(groupId, removedId, newEpoch, text)
        for (const [machineId, sealed] of Object.entries(packages)) {
          stmts.insertPackage.run(groupId, machineId, newEpoch, text, sealed)
        }
        stmts.cancelInvites.run(groupId)
        return { ok: true, epoch: newEpoch }
      })
    },
    // [{ epoch, record (object), sealed }] in epoch order.
    packagesFor(groupId, machineId) {
      return stmts.packagesFor.all(groupId, machineId).map((r) => ({
        epoch: r.epoch,
        record: JSON.parse(r.record),
        sealed: r.sealed,
      }))
    },
    deletePackages(groupId, machineId, upToEpoch) {
      stmts.deletePackages.run(groupId, machineId, upToEpoch)
    },
    latestRemoval(groupId, machineId) {
      const r = stmts.latestRemoval.get(groupId, machineId)
      return r ? JSON.parse(r.record) : null
    },

    deleteGroup(groupId) {
      transaction(() => {
        for (const table of ['rekey_packages', 'removals', 'invites', 'machines']) {
          db.prepare(`DELETE FROM ${table} WHERE group_id = ?`).run(groupId)
        }
        db.prepare('DELETE FROM groups WHERE id = ?').run(groupId)
      })
    },
  }
  return store
}
