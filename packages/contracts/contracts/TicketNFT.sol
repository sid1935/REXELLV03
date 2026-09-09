// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessRegistry} from "./AccessRegistry.sol";
import {ResaleMode, TierPolicy} from "./Types.sol";

/**
 * One of these per event.
 *
 * It is an ERC-721 so that wallets and explorers can read it, and so the
 * entitlement is a public, verifiable object. It is emphatically NOT a tradeable
 * NFT: there is no code path by which an ordinary holder can transfer a token to
 * an ordinary address.
 *
 *   Bound tier   → `_update` reverts on any owner-to-owner move, forever.
 *   Capped tier  → `_update` reverts unless the caller is the ResaleController,
 *                  which is where ceiling, window and cooldown are enforced.
 *
 * `approve` and `setApprovalForAll` revert outright. An approval that can never
 * be exercised is a lie told to wallets and marketplaces, and leaving them
 * functional is how a "non-transferable" token ends up with a listing page.
 */
contract TicketNFT is ERC721 {
    error NotMinter();
    error NotGate();
    error NotAdmin();
    error NotController();
    error TicketIsBound(uint256 tokenId);
    error TransfersMustGoThroughController(uint256 tokenId);
    error ApprovalsDisabled();
    error UnknownTier(uint16 tierId);
    error TierSoldOut(uint16 tierId);
    error IdentityNotBound(bytes32 identityId);
    error AlreadyRedeemed(uint256 tokenId);
    error TicketIsRevoked(uint256 tokenId);
    error CapacityExceeded();

    event TicketMinted(uint256 indexed tokenId, bytes32 indexed identityId, uint16 indexed tierId);
    event TicketRedeemed(uint256 indexed tokenId, bytes32 indexed identityId, uint64 at);
    event TicketRevoked(uint256 indexed tokenId, string reason);
    event TicketRebound(uint256 indexed tokenId, bytes32 indexed from, bytes32 indexed to, uint8 resaleCount);

    struct TicketData {
        bytes32 identityId;
        uint16 tierId;
        uint64 acquiredAt;
        uint8 resaleCount;
        bool redeemed;
        bool revoked;
    }

    address public immutable admin;
    address public immutable minter;
    address public immutable gate;
    address public immutable resaleController;
    AccessRegistry public immutable registry;

    /// The hash the organizer committed to at event creation. Anchors the terms.
    bytes32 public immutable policyHash;
    uint32 public immutable capacity;

    uint16 public tierCount;
    uint256 public nextTokenId = 1;
    uint32 public minted;

    mapping(uint16 => TierPolicy) private _tiers;
    mapping(uint16 => uint32) public mintedInTier;
    mapping(uint256 => TicketData) private _tickets;

    constructor(
        string memory name_,
        string memory symbol_,
        address minter_,
        address gate_,
        address resaleController_,
        AccessRegistry registry_,
        bytes32 policyHash_,
        uint32 capacity_,
        TierPolicy[] memory tiers_
    ) ERC721(name_, symbol_) {
        admin = msg.sender;
        minter = minter_;
        gate = gate_;
        resaleController = resaleController_;
        registry = registry_;
        policyHash = policyHash_;
        capacity = capacity_;

        uint32 allocated;
        for (uint16 i = 0; i < tiers_.length; i++) {
            _tiers[i] = tiers_[i];
            allocated += tiers_[i].allocation;
        }
        // Overselling is an invariant, not a warning. Enforced here as well as in
        // the domain layer and the database, because the failure mode is a person
        // at a turnstile holding a ticket for a space that does not exist.
        if (allocated > capacity_) revert CapacityExceeded();
        tierCount = uint16(tiers_.length);
    }

    // ─── views ───────────────────────────────────────────────────────────────

    function tier(uint16 tierId) public view returns (TierPolicy memory) {
        if (tierId >= tierCount) revert UnknownTier(tierId);
        return _tiers[tierId];
    }

    function ticket(uint256 tokenId) external view returns (TicketData memory) {
        _requireOwned(tokenId);
        return _tickets[tokenId];
    }

    function identityOf(uint256 tokenId) external view returns (bytes32) {
        _requireOwned(tokenId);
        return _tickets[tokenId].identityId;
    }

    /** The highest price this tier may be resold at. */
    function ceilingOf(uint16 tierId) public view returns (uint96) {
        TierPolicy memory p = tier(tierId);
        return uint96((uint256(p.faceValue) * p.maxPriceBps) / 10_000);
    }

    function floorOf(uint16 tierId) public view returns (uint96) {
        TierPolicy memory p = tier(tierId);
        return uint96((uint256(p.faceValue) * p.minPriceBps) / 10_000);
    }

    /** Valid for entry. A listed ticket still counts — it is yours until it sells. */
    function isValidForEntry(uint256 tokenId) external view returns (bool) {
        TicketData memory t = _tickets[tokenId];
        return _ownerOf(tokenId) != address(0) && !t.revoked && !t.redeemed;
    }

    // ─── issuance ────────────────────────────────────────────────────────────

    function mintTo(bytes32 identityId, uint16 tierId) external returns (uint256 tokenId) {
        if (msg.sender != minter) revert NotMinter();
        TierPolicy memory p = tier(tierId);

        address account = registry.accountOf(identityId);
        // A ticket minted to an unbound identity belongs to nobody and opens no
        // gate. Refusing here is what makes the binding load-bearing.
        if (account == address(0)) revert IdentityNotBound(identityId);

        if (mintedInTier[tierId] >= p.allocation) revert TierSoldOut(tierId);
        if (minted >= capacity) revert CapacityExceeded();

        tokenId = nextTokenId++;
        mintedInTier[tierId] += 1;
        minted += 1;

        _tickets[tokenId] = TicketData({
            identityId: identityId,
            tierId: tierId,
            acquiredAt: uint64(block.timestamp),
            resaleCount: 0,
            redeemed: false,
            revoked: false
        });

        _safeMint(account, tokenId);
        emit TicketMinted(tokenId, identityId, tierId);
    }

    // ─── the gate ────────────────────────────────────────────────────────────

    function redeem(uint256 tokenId) external {
        if (msg.sender != gate) revert NotGate();
        TicketData storage t = _tickets[tokenId];
        _requireOwned(tokenId);
        if (t.revoked) revert TicketIsRevoked(tokenId);
        if (t.redeemed) revert AlreadyRedeemed(tokenId);

        t.redeemed = true;
        emit TicketRedeemed(tokenId, t.identityId, uint64(block.timestamp));
    }

    function revoke(uint256 tokenId, string calldata reason) external {
        if (msg.sender != admin) revert NotAdmin();
        _requireOwned(tokenId);
        _tickets[tokenId].revoked = true;
        emit TicketRevoked(tokenId, reason);
    }

    // ─── resale, via the controller only ─────────────────────────────────────

    /**
     * The single path by which a ticket changes hands.
     *
     * Rebinding the credential is part of the same call as the transfer, not a
     * follow-up. If the two could come apart, there would be a window in which
     * the token belongs to the buyer while the gate still admits the seller —
     * and that window is the entire attack.
     */
    function controllerTransfer(uint256 tokenId, bytes32 toIdentity) external returns (address to) {
        if (msg.sender != resaleController) revert NotController();
        TicketData storage t = _tickets[tokenId];
        if (t.revoked) revert TicketIsRevoked(tokenId);
        if (t.redeemed) revert AlreadyRedeemed(tokenId);

        to = registry.accountOf(toIdentity);
        if (to == address(0)) revert IdentityNotBound(toIdentity);

        bytes32 from = t.identityId;
        address owner = _requireOwned(tokenId);

        t.identityId = toIdentity;
        t.acquiredAt = uint64(block.timestamp);
        t.resaleCount += 1;

        _transfer(owner, to, tokenId);
        emit TicketRebound(tokenId, from, toIdentity, t.resaleCount);
    }

    // ─── the guard ───────────────────────────────────────────────────────────

    /**
     * Every ownership change in ERC-721 v5 funnels through here, including
     * `transferFrom`, `safeTransferFrom`, mint and burn. Which makes this the one
     * place the "no third mode" rule has to hold.
     */
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);

        // from == 0 is a mint, to == 0 is a burn. Neither is a transfer between
        // holders, and neither is what this guard is about.
        if (from != address(0) && to != address(0)) {
            if (_tiers[_tickets[tokenId].tierId].mode == ResaleMode.Bound) {
                revert TicketIsBound(tokenId);
            }
            if (msg.sender != resaleController) {
                revert TransfersMustGoThroughController(tokenId);
            }
        }

        return super._update(to, tokenId, auth);
    }

    /**
     * Approvals are disabled.
     *
     * Transfers only work when the controller calls `controllerTransfer`, so an
     * approval could never be exercised anyway. Reverting rather than silently
     * accepting means a marketplace's "list this item" flow fails at the approval
     * step, loudly, instead of producing a listing page for a ticket that can
     * never be delivered.
     */
    function approve(address, uint256) public pure override {
        revert ApprovalsDisabled();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert ApprovalsDisabled();
    }
}
