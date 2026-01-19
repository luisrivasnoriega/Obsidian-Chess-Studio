import { MultiSelect } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { commands, type Player } from "@/bindings";
import { query_players } from "@/utils/db";
import { unwrap } from "@/utils/unwrap";

export function MultiPlayerSearchInput({
  label,
  value,
  file,
  setValue,
}: {
  label: string;
  value: number[];
  file: string;
  setValue: (val: number[]) => void;
}) {
  const [searchValue, setSearchValue] = useState("");
  const [data, setData] = useState<Player[]>([]);
  const [knownNamesById, setKnownNamesById] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    async function hydrateSelected() {
      const missing = value.filter((id) => !knownNamesById.has(id));
      if (missing.length === 0) return;
      const results = await Promise.all(missing.map((id) => commands.getPlayer(file, id)));
      if (cancelled) return;
      setKnownNamesById((prev) => {
        const next = new Map(prev);
        for (const res of results) {
          const player = unwrap(res);
          if (player?.id != null && player.name) {
            next.set(player.id, player.name);
          }
        }
        return next;
      });
    }
    hydrateSelected();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, value.join(",")]);

  const selectData = useMemo(() => {
    const merged = new Map<string, string>();

    for (const p of data) {
      if (p.id != null && p.name) {
        merged.set(String(p.id), p.name);
      }
    }

    for (const id of value) {
      const name = knownNamesById.get(id);
      if (name) {
        merged.set(String(id), name);
      }
    }

    return Array.from(merged.entries()).map(([id, name]) => ({ value: id, label: name }));
  }, [data, knownNamesById, value]);

  async function handleSearchChange(val: string) {
    setSearchValue(val);
    if (val.trim().length === 0) {
      setData([]);
      return;
    }

    const res = await query_players(file, {
      name: val,
      options: {
        page: 1,
        pageSize: 10,
        skipCount: true,
        sort: "elo",
        direction: "asc",
      },
    });
    setData(res.data);
  }

  return (
    <MultiSelect
      value={value.map(String)}
      data={selectData}
      onChange={(ids) => {
        const next = ids
          .map((s) => Number.parseInt(s, 10))
          .filter((n) => Number.isFinite(n))
          .map((n) => Math.trunc(n));
        setValue(next);
      }}
      searchable
      searchValue={searchValue}
      onSearchChange={handleSearchChange}
      leftSection={<IconSearch size="1rem" />}
      placeholder={label}
      clearable
      comboboxProps={{ withinPortal: false }}
    />
  );
}

