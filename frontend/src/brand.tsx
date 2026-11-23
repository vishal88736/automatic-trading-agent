export function KronoMark() {
  return (
    <img
      className="krono-mark"
      src={`${import.meta.env.BASE_URL}krono-mark.svg`}
      alt=""
      width={48}
      height={48}
    />
  );
}

export function KronoBrand() {
  return (
    <>
      <KronoMark />
      <svg className="krono-wordmark" viewBox="0 0 484 90" aria-hidden>
        <g fill="currentColor">
          <path d="M0 2h19v32h18L63 2h24L51 44l38 44H64L36 52H19v36H0z" />
          <path d="M97 2h56c18 0 29 11 29 28 0 14-8 23-20 26l23 32h-23l-21-31h-21c-3 0-5 2-5 5v26H97V61c0-14 7-21 21-21h34c7 0 11-3 11-10s-4-10-11-10H97z" />
          <path
            fillRule="evenodd"
            d="M236 0c28 0 46 18 46 45s-18 45-46 45-46-18-46-45 18-45 46-45Zm0 18c-16 0-27 11-27 27s11 27 27 27 27-11 27-27-11-27-27-27Z"
          />
          <path d="M293 2h18l50 57V2h19v86h-18l-50-57v57h-19z" />
          <path d="M434 0v18c-15 2-24 13-24 27 0 16 11 27 27 27s27-11 27-27c0-7-2-13-6-18l14-13c7 8 11 19 11 31 0 27-18 45-46 45s-46-18-46-45c0-26 17-44 43-45Z" />
        </g>
        <path
          className="krono-wordmark-signal"
          d="M441 0c10 1 19 5 26 10l-13 13c-4-3-8-5-13-5z m-8 40 15-12 6 7-14 13z"
        />
      </svg>
      <span className="visually-hidden">Krono</span>
    </>
  );
}
