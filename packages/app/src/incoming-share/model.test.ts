import { describe, expect, it } from "vitest";
import { redirectSystemPath } from "@/app/+native-intent";
import {
  InvalidIncomingShareError,
  isShareExtensionUrl,
  MAX_INCOMING_SHARE_FILES,
  parseIncomingShare,
} from "./model";

describe("parseIncomingShare", () => {
  it("reads iOS text shares from the JSON string the native module sends", () => {
    const share = parseIncomingShare(
      JSON.stringify({ text: "  fix the flaky test  ", type: "text" }),
    );
    expect(share).toEqual({ text: "fix the flaky test", files: [], droppedFileCount: 0 });
  });

  it("puts the page title above a Safari link", () => {
    const share = parseIncomingShare(
      JSON.stringify({
        weburls: [
          {
            url: "https://example.com/post",
            meta: JSON.stringify({ title: "A post", "og:image": "x" }),
          },
        ],
        type: "weburl",
      }),
    );
    expect(share?.text).toBe("A post\nhttps://example.com/post");
  });

  it("keeps a link whose metadata is unreadable", () => {
    const share = parseIncomingShare({
      weburls: [{ url: "https://example.com", meta: "not json" }],
      type: "weburl",
    });
    expect(share?.text).toBe("https://example.com");
  });

  it("adds an Android title only to a bare link", () => {
    expect(
      parseIncomingShare({ text: "https://example.com", meta: { title: "Example" }, type: "text" })
        ?.text,
    ).toBe("Example\nhttps://example.com");
    expect(
      parseIncomingShare({
        text: "Look at https://example.com",
        meta: { title: "Example" },
        type: "text",
      })?.text,
    ).toBe("Look at https://example.com");
  });

  it("splits iOS media into images and files", () => {
    const share = parseIncomingShare(
      JSON.stringify({
        files: [
          {
            path: "/private/var/mobile/Containers/Shared/AppGroup/x/IMG_1.png",
            fileName: "IMG_1.png",
            mimeType: "image/png",
            type: "0",
          },
          {
            path: "file:///private/var/mobile/Containers/Shared/AppGroup/x/clip.mov",
            fileName: "clip.mov",
            mimeType: "video/quicktime",
            type: "0",
          },
        ],
        type: "media",
      }),
    );
    expect(share?.files).toEqual([
      {
        kind: "image",
        uri: "/private/var/mobile/Containers/Shared/AppGroup/x/IMG_1.png",
        fileName: "IMG_1.png",
        mimeType: "image/png",
      },
      {
        kind: "file",
        uri: "file:///private/var/mobile/Containers/Shared/AppGroup/x/clip.mov",
        fileName: "clip.mov",
        mimeType: "video/quicktime",
      },
    ]);
  });

  it("prefers the Android content URI and skips the stray type entry", () => {
    const share = parseIncomingShare({
      files: [
        {
          contentUri: "content://media/external/images/media/42",
          filePath: "/storage/emulated/0/DCIM/Screenshots/shot.jpg",
          fileName: "shot.jpg",
          mimeType: "image/jpeg",
          fileSize: "1024",
        },
        { first: "type", second: "file" },
      ],
      type: "file",
    });
    expect(share?.files).toEqual([
      {
        kind: "image",
        uri: "content://media/external/images/media/42",
        fileName: "shot.jpg",
        mimeType: "image/jpeg",
      },
    ]);
  });

  it("names files that arrive without a name", () => {
    const share = parseIncomingShare({
      files: [
        { contentUri: "content://downloads/7", mimeType: "application/pdf" },
        { path: "/tmp/notes.txt", mimeType: null },
      ],
    });
    expect(share?.files.map((file) => [file.fileName, file.mimeType])).toEqual([
      ["shared-file-1", "application/pdf"],
      ["notes.txt", "application/octet-stream"],
    ]);
  });

  it("keeps the first eight files and counts the rest", () => {
    const files = Array.from({ length: MAX_INCOMING_SHARE_FILES + 3 }, (_, index) => ({
      path: `/tmp/photo-${index}.jpg`,
      mimeType: "image/jpeg",
    }));
    const share = parseIncomingShare({ files });
    expect(share?.files).toHaveLength(MAX_INCOMING_SHARE_FILES);
    expect(share?.droppedFileCount).toBe(3);
  });

  it("drops duplicate files", () => {
    const share = parseIncomingShare({
      files: [
        { path: "/tmp/a.png", mimeType: "image/png" },
        { path: "/tmp/a.png", mimeType: "image/png" },
      ],
    });
    expect(share?.files).toHaveLength(1);
  });

  it("returns null for a share with nothing usable", () => {
    expect(parseIncomingShare({ text: "   ", files: [{ fileName: "ghost" }] })).toBeNull();
  });

  it("rejects payloads that are not shares", () => {
    expect(() => parseIncomingShare("{not json")).toThrow(InvalidIncomingShareError);
    expect(() => parseIncomingShare(42)).toThrow(InvalidIncomingShareError);
  });
});

describe("share extension URLs", () => {
  it("recognizes the reopen URL for any scheme", () => {
    expect(isShareExtensionUrl("paseo://dataUrl=paseoShareKey#media")).toBe(true);
    expect(isShareExtensionUrl("paseo-debug://dataUrl=paseo-debugShareKey#text")).toBe(true);
    expect(isShareExtensionUrl("paseo://h/server/agent/abc")).toBe(false);
  });

  it("keeps routing on startup restore and leaves other links alone", () => {
    const url = "paseo://dataUrl=paseoShareKey#media";
    expect(redirectSystemPath({ path: url, initial: true })).toBe("/");
    expect(redirectSystemPath({ path: url, initial: false })).toBe("");
    expect(redirectSystemPath({ path: "paseo://settings", initial: false })).toBe(
      "paseo://settings",
    );
  });
});
