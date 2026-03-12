async function readPosts(page) {
  return page.evaluate(() => {
    const posts = [];
    document.querySelectorAll("article").forEach((el, index) => {
      const likeButton = el.querySelector('[aria-label*="Like"], [data-testid="like"], svg[aria-label*="Like"]');
      const alreadyLiked = Boolean(
        el.querySelector('[aria-label*="Unlike"], [data-testid="unlike"], svg[aria-label*="Unlike"]'),
      );
      const adHint = el.innerText || "";
      // Try multiple selectors for author username (Threads DOM structure varies)
      let authorUsername = null;
      const authorHrefLink = el.querySelector('a[href^="/@"]');
      if (authorHrefLink) {
        authorUsername = (authorHrefLink.getAttribute("href") || "").replace(/^\/@/, "") || null;
      }
      if (!authorUsername) {
        // Fallback: look for aria-label on profile link
        const ariaLink = el.querySelector('a[aria-label][href*="/"]');
        if (ariaLink) {
          const href = ariaLink.getAttribute("href") || "";
          const match = href.match(/^\/?@?([A-Za-z0-9_\.]+)\/?$/);
          if (match) authorUsername = match[1];
        }
      }
      if (!authorUsername) {
        // Fallback: look for data-testid username span
        const nameSpan = el.querySelector('[data-testid="username"], [data-testid="User-Name"]');
        if (nameSpan) {
          const raw = (nameSpan.innerText || "").replace(/^@/, "").trim();
          if (raw) authorUsername = raw;
        }
      }
      const postLink = el.querySelector('a[href*="/post/"]');
      const postUrl = postLink ? postLink.getAttribute("href") || null : null;
      posts.push({
        id: el.getAttribute("data-id") || null,
        text: el.innerText || "",
        index,
        alreadyLiked,
        isAd: /贊助|Sponsored|廣告|sponsored/i.test(adHint),
        canLike: Boolean(likeButton),
        authorUsername,
        postUrl,
      });
    });
    return posts;
  });
}

async function readVisiblePosts(page) {
  const posts = await readPosts(page);
  return posts.filter((post) => String(post.text || "").trim());
}

module.exports = { readPosts, readVisiblePosts };
