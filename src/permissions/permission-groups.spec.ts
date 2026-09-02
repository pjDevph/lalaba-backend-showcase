import { PERMISSION_CATALOGUE } from './permission-catalogue';
import {
  ALL_PERMISSION_GROUPS,
  PERMISSION_GROUP_MEMBERS,
  PermissionGroup,
  expandGroups,
  groupsFromNames,
} from './permission-groups';

describe('permission groups', () => {
  const catalogueNames = PERMISSION_CATALOGUE.map((p) => p.permissionName);
  const groupedNames = ALL_PERMISSION_GROUPS.flatMap(
    (g) => PERMISSION_GROUP_MEMBERS[g],
  );

  // The whole point of the four-switch UI is that ticking every switch grants
  // everything and ticking none grants nothing. Both halves of that are only
  // true while the groups partition the catalogue.
  describe('partition the catalogue', () => {
    it('files every catalogue permission into a group', () => {
      const missing = catalogueNames.filter((n) => !groupedNames.includes(n));
      expect(missing).toEqual([]);
    });

    it('has no group member that is absent from the catalogue', () => {
      const unknown = groupedNames.filter((n) => !catalogueNames.includes(n));
      expect(unknown).toEqual([]);
    });

    it('files each permission into exactly one group', () => {
      const seen = new Map<string, PermissionGroup[]>();
      for (const group of ALL_PERMISSION_GROUPS) {
        for (const name of PERMISSION_GROUP_MEMBERS[group]) {
          seen.set(name, [...(seen.get(name) ?? []), group]);
        }
      }
      const duplicated = [...seen.entries()].filter(
        ([, groups]) => groups.length > 1,
      );
      expect(duplicated).toEqual([]);
    });
  });

  describe('expandGroups', () => {
    it('expands every group to the full catalogue', () => {
      expect(expandGroups(ALL_PERMISSION_GROUPS).sort()).toEqual(
        [...catalogueNames].sort(),
      );
    });

    it('returns nothing for an empty or missing selection', () => {
      expect(expandGroups([])).toEqual([]);
      expect(expandGroups(undefined)).toEqual([]);
      expect(expandGroups(null)).toEqual([]);
    });

    it('de-duplicates nothing away when groups are disjoint', () => {
      const expanded = expandGroups([
        PermissionGroup.ORDERS,
        PermissionGroup.SERVICES,
      ]);
      expect(expanded).toHaveLength(
        PERMISSION_GROUP_MEMBERS.ORDERS.length +
          PERMISSION_GROUP_MEMBERS.SERVICES.length,
      );
    });
  });

  describe('groupsFromNames', () => {
    it('round-trips a set of groups', () => {
      const groups = [PermissionGroup.ORDERS, PermissionGroup.OTHERS];
      expect(groupsFromNames(expandGroups(groups))).toEqual(groups);
    });

    it('switches a group on for a single member — the partial-holding case', () => {
      // Exactly the shape the old implicit staff floor left behind.
      expect(
        groupsFromNames([
          'order_confirm_pickup',
          'order_update_status',
          'inventory_edit',
        ]),
      ).toEqual([PermissionGroup.ORDERS, PermissionGroup.INVENTORY]);
    });

    it('returns nothing for an empty or missing holding', () => {
      expect(groupsFromNames([])).toEqual([]);
      expect(groupsFromNames(undefined)).toEqual([]);
      expect(groupsFromNames(null)).toEqual([]);
    });

    it('ignores names outside the catalogue', () => {
      expect(groupsFromNames(['not_a_permission'])).toEqual([]);
    });
  });
});
