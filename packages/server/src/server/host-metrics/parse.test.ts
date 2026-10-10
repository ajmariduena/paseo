import { describe, expect, it } from "vitest";
import {
  parseDarwinPressureLevel,
  parseDf,
  parseOsReleasePrettyName,
  parseProcEnviron,
  parseProcMeminfo,
  parsePs,
  parsePsEnvironment,
  parseVmStatUsedBytes,
  selectDisks,
  selectTopProcesses,
  type PsRow,
} from "./parse.js";

const KIB = 1024;

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4413.
Pages active:                                 276474.
Pages inactive:                               250989.
Pages speculative:                             25557.
Pages throttled:                                   0.
Pages wired down:                             403315.
Pages purgeable:                                5054.
"Translation faults":                    17809195345.
Pages copy-on-write:                       867354828.
File-backed pages:                            192187.
Anonymous pages:                              360833.
Pages stored in compressor:                  2137839.
Pages occupied by compressor:                 555727.
Decompressions:                           2881238494.
`;

const DARWIN_DF = `Filesystem         1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1       971298980  12275392 118498072    10%    /
devfs                      208       208         0   100%    /dev
/dev/disk3s6         971298980   9437272 118498072     8%    /System/Volumes/VM
/dev/disk3s2         971298980  10533260 118498072     9%    /System/Volumes/Preboot
/dev/disk3s4         971298980      3812 118498072     1%    /System/Volumes/Update
/dev/disk1s2            563200      6164    543344     2%    /System/Volumes/xarts
/dev/disk3s5         971298980 817568804 118498072    88%    /System/Volumes/Data
map auto_home                0         0         0   100%    /System/Volumes/Data/home
OrbStack:/OrbStack   123535360  11027268 112508092     9%    /Users/me/OrbStack
/dev/disk5s1          17659904  17159516    455144    98%    /Library/Developer/CoreSimulator/Volumes/iOS_23F77
/dev/disk7s1            235480    134904     99132    58%    /Volumes/VMPal
/dev/disk8s1           1000000    400000    600000    40%    /Volumes/My Backup
//me@nas/share         2000000   1500000    500000    75%    /Volumes/share
`;

const LINUX_DF = `Filesystem     1024-blocks      Used  Available Capacity Mounted on
udev               8123456         0    8123456       0% /dev
tmpfs              1630000      2000    1628000       1% /run
/dev/nvme0n1p2   490000000 210000000  255000000      46% /
tmpfs              8150000         0    8150000       0% /dev/shm
/dev/loop0           64000     64000          0     100% /snap/core20/2105
/dev/nvme0n1p1      523248      6220     517028       2% /boot/efi
/dev/sdb1       1900000000 800000000 1000000000      45% /mnt/media
/dev/nvme0n1p2   490000000 210000000  255000000      46% /srv/bind
overlay          490000000 210000000  255000000      46% /var/lib/docker/overlay2/abc/merged
tmpfs              1630000       100    1629900       1% /run/user/1000
`;

const CHROME_RENDERER_PATH =
  "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/131.0/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)";

function psRow(pid: number, cpuPercent: number, memoryKib: number): PsRow {
  return { pid, ppid: 1, cpuPercent, memoryBytes: memoryKib * KIB, name: `p${pid}` };
}

describe("parseVmStatUsedBytes", () => {
  it("counts active, wired and compressed pages at the reported page size", () => {
    expect(parseVmStatUsedBytes(VM_STAT)).toBe((276474 + 403315 + 555727) * 16384);
  });

  it("returns null when the page size header is missing", () => {
    expect(parseVmStatUsedBytes("Pages active: 10.\n")).toBeNull();
  });
});

describe("parseDarwinPressureLevel", () => {
  it.each([
    ["1\n", "normal"],
    ["2\n", "warn"],
    ["4\n", "critical"],
    ["0\n", null],
  ])("maps %j to %s", (output, expected) => {
    expect(parseDarwinPressureLevel(output)).toBe(expected);
  });
});

describe("parseProcMeminfo", () => {
  it.each([
    [8_000_000, "normal"],
    [2_400_000, "warn"],
    [1_000_000, "critical"],
  ])("with %d kB available reports %s pressure", (availableKib, pressure) => {
    const output = `MemTotal:       16000000 kB\nMemFree:          500000 kB\nMemAvailable:   ${availableKib} kB\nBuffers:          100000 kB\n`;
    expect(parseProcMeminfo(output)).toEqual({
      usedBytes: (16_000_000 - availableKib) * KIB,
      pressure,
    });
  });

  it("returns null without MemAvailable", () => {
    expect(parseProcMeminfo("MemTotal: 16000000 kB\n")).toBeNull();
  });
});

describe("parseOsReleasePrettyName", () => {
  it("reads the quoted PRETTY_NAME", () => {
    const output = 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n';
    expect(parseOsReleasePrettyName(output)).toBe("Ubuntu 24.04.1 LTS");
  });
});

describe("selectDisks", () => {
  it("presents the macOS data volume as the main disk and drops system volumes", () => {
    const disks = selectDisks({
      rows: parseDf(DARWIN_DF),
      platform: "darwin",
      mainVolumeName: "Macintosh HD",
    });
    expect(disks).toEqual([
      {
        mount: "/",
        name: "Macintosh HD",
        totalBytes: 971298980 * KIB,
        usedBytes: (971298980 - 118498072) * KIB,
      },
      {
        mount: "/Volumes/VMPal",
        name: "VMPal",
        totalBytes: 235480 * KIB,
        usedBytes: (235480 - 99132) * KIB,
      },
      {
        mount: "/Volumes/My Backup",
        name: "My Backup",
        totalBytes: 1000000 * KIB,
        usedBytes: 400000 * KIB,
      },
      {
        mount: "/Volumes/share",
        name: "share",
        totalBytes: 2000000 * KIB,
        usedBytes: 1500000 * KIB,
      },
    ]);
  });

  it("names the macOS main disk System when the volume name is unknown", () => {
    const disks = selectDisks({
      rows: parseDf(DARWIN_DF),
      platform: "darwin",
      mainVolumeName: null,
    });
    expect(disks[0]).toMatchObject({ mount: "/", name: "System" });
  });

  it("keeps Linux block devices, drops pseudo filesystems and dedupes bind mounts", () => {
    const disks = selectDisks({ rows: parseDf(LINUX_DF), platform: "linux", mainVolumeName: null });
    expect(disks).toEqual([
      {
        mount: "/",
        name: "/",
        totalBytes: 490000000 * KIB,
        usedBytes: (490000000 - 255000000) * KIB,
      },
      {
        mount: "/mnt/media",
        name: "/mnt/media",
        totalBytes: 1900000000 * KIB,
        usedBytes: 900000000 * KIB,
      },
    ]);
  });
});

describe("parsePs", () => {
  it("keeps macOS executable names with spaces and parentheses", () => {
    const output = [
      "    1     0   0.9  19296 /sbin/launchd",
      `  612     1  12.5 412000 ${CHROME_RENDERER_PATH}`,
      "  700   612   0,4   2048 /usr/local/bin/node",
      "",
    ].join("\n");
    expect(parsePs(output, "darwin")).toEqual([
      { pid: 1, ppid: 0, cpuPercent: 0.9, memoryBytes: 19296 * KIB, name: "launchd" },
      {
        pid: 612,
        ppid: 1,
        cpuPercent: 12.5,
        memoryBytes: 412000 * KIB,
        name: "Google Chrome Helper (Renderer)",
      },
      { pid: 700, ppid: 612, cpuPercent: 0.4, memoryBytes: 2048 * KIB, name: "node" },
    ]);
  });

  it("keeps Linux task names that contain a slash", () => {
    expect(parsePs("   42     2  0.0     0 kworker/0:1H-kblockd\n", "linux")).toEqual([
      { pid: 42, ppid: 2, cpuPercent: 0, memoryBytes: 0, name: "kworker/0:1H-kblockd" },
    ]);
  });
});

describe("selectTopProcesses", () => {
  it("merges the top by CPU with the top by memory, sorted by CPU", () => {
    const rows = [
      psRow(1, 50, 100),
      psRow(2, 30, 10),
      psRow(3, 1, 900),
      psRow(4, 0, 800),
      psRow(5, 5, 50),
    ];
    expect(selectTopProcesses(rows, 2).map((row) => row.pid)).toEqual([1, 2, 3, 4]);
  });
});

describe("agent environment lookup", () => {
  it("reads PASEO_AGENT_ID from ps -E output", () => {
    const output = [
      "  700 /usr/local/bin/node server.js TERM=xterm PASEO_AGENT_ID=agent-1 HOME=/Users/me",
      "  701 /bin/zsh -l PATH=/usr/bin XPASEO_AGENT_ID=nope",
      "",
    ].join("\n");
    expect(parsePsEnvironment(output)).toEqual(
      new Map([
        [700, "agent-1"],
        [701, null],
      ]),
    );
  });

  it("reads PASEO_AGENT_ID from a NUL-separated /proc environ", () => {
    expect(parseProcEnviron("PATH=/usr/bin\0PASEO_AGENT_ID=agent-2\0HOME=/root\0")).toBe("agent-2");
    expect(parseProcEnviron("PATH=/usr/bin\0")).toBeNull();
  });
});
