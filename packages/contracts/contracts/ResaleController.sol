// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessRegistry} from "./AccessRegistry.sol";
import {RoyaltySplitter} from "./RoyaltySplitter.sol";
import {TicketNFT} from "./TicketNFT.sol";
import {ResaleMode, TierPolicy} from "./Types.sol";

/**
 * The only path through which a ticket may change hands.
 *
 * Every check in here has a twin in `packages/domain/src/resale.ts`. That
 * duplication is the design, not an accident: the TypeScript version exists so a
 * fan finds out in the interface instead of in a reverted transaction, and this
 * version exists because the interface is not the enforcement point. An
 * organizer's price ceiling has to survive a bug in our own frontend, a
 * compromised API key, and somebody talking directly to the chain.
 */
contract ResaleController {
    error NotOperator();
    error ResaleDisabled(uint256 tokenId);
    error WindowNotOpen(uint64 opensAt);
    error WindowClosed(uint64 closesAt);
    error CooldownActive(uint64 until);
    error PriceAboveCeiling(uint96 ceiling, uint96 requested);
    error PriceBelowFloor(uint96 floorPrice, uint96 requested);
    error ResaleLimitReached(uint8 count, uint8 max);
    error NotTicketOwner();
    error ListingNotActive(uint256 listingId);
    error CannotBuyOwnListing();
    error PriceChanged(uint96 shown, uint96 actual);
    error BuyerNotBound(bytes32 identityId);
    error TicketNotListable(uint256 tokenId);

    event Listed(uint256 indexed listingId, uint256 indexed tokenId, bytes32 indexed sellerIdentity, uint96 price);
    event Cancelled(uint256 indexed listingId);
    event Sold(uint256 indexed listingId, uint256 indexed tokenId, bytes32 indexed buyerIdentity, uint96 price);

    struct Listing {
        address ticketContract;
        uint256 tokenId;
        bytes32 sellerIdentity;
        uint96 price;
        bool active;
    }

    address public immutable admin;
    AccessRegistry public immutable registry;
    RoyaltySplitter public splitter;

    /// The backend relayer. Fans never hold gas or sign; see the paymaster note in §04.
    mapping(address => bool) public isOperator;

    uint256 public nextListingId = 1;
    mapping(uint256 => Listing) public listings;
    /// One live listing per ticket, so a race cannot sell the same seat twice.
    mapping(address => mapping(uint256 => uint256)) public activeListingOf;

    modifier onlyOperator() {
        if (!isOperator[msg.sender]) revert NotOperator();
        _;
    }

    constructor(AccessRegistry registry_, address operator) {
        admin = msg.sender;
        registry = registry_;
        isOperator[operator] = true;
    }

    function setSplitter(RoyaltySplitter splitter_) external {
        if (msg.sender != admin) revert NotOperator();
        splitter = splitter_;
    }

    function setOperator(address operator, bool allowed) external {
        if (msg.sender != admin) revert NotOperator();
        isOperator[operator] = allowed;
    }

    // ─── listing ─────────────────────────────────────────────────────────────

    function list(
        TicketNFT ticketContract,
        uint256 tokenId,
        bytes32 sellerIdentity,
        uint96 price
    ) external onlyOperator returns (uint256 listingId) {
        TicketNFT.TicketData memory t = ticketContract.ticket(tokenId);
        TierPolicy memory p = ticketContract.tier(t.tierId);

        if (p.mode == ResaleMode.Bound) revert ResaleDisabled(tokenId);
        if (t.revoked || t.redeemed) revert TicketNotListable(tokenId);
        if (t.identityId != sellerIdentity) revert NotTicketOwner();

        if (block.timestamp < p.opensAt) revert WindowNotOpen(p.opensAt);
        if (block.timestamp >= p.closesAt) revert WindowClosed(p.closesAt);

        uint64 cooldownEnds = t.acquiredAt + p.cooldown;
        if (p.cooldown > 0 && block.timestamp < cooldownEnds) revert CooldownActive(cooldownEnds);

        if (t.resaleCount >= p.maxResales) revert ResaleLimitReached(t.resaleCount, p.maxResales);

        uint96 ceiling = ticketContract.ceilingOf(t.tierId);
        uint96 floorPrice = ticketContract.floorOf(t.tierId);
        if (price > ceiling) revert PriceAboveCeiling(ceiling, price);
        if (price < floorPrice) revert PriceBelowFloor(floorPrice, price);

        uint256 existing = activeListingOf[address(ticketContract)][tokenId];
        if (existing != 0 && listings[existing].active) revert ListingNotActive(existing);

        listingId = nextListingId++;
        listings[listingId] = Listing({
            ticketContract: address(ticketContract),
            tokenId: tokenId,
            sellerIdentity: sellerIdentity,
            price: price,
            active: true
        });
        activeListingOf[address(ticketContract)][tokenId] = listingId;

        emit Listed(listingId, tokenId, sellerIdentity, price);
    }

    function cancel(uint256 listingId) external onlyOperator {
        Listing storage l = listings[listingId];
        if (!l.active) revert ListingNotActive(listingId);
        l.active = false;
        delete activeListingOf[l.ticketContract][l.tokenId];
        emit Cancelled(listingId);
    }

    // ─── buying ──────────────────────────────────────────────────────────────

    /**
     * Settle a resale.
     *
     * `expectedPrice` is the number the buyer was actually shown. Without it, a
     * price change between viewing and confirming charges somebody more than
     * they agreed to — the same problem a limit order solves.
     *
     * The ceiling is re-checked here even though `list` already enforced it,
     * because the two calls are separated in time and a policy could in principle
     * be read from a different tier. Re-reading it costs one view call.
     */
    function buy(
        uint256 listingId,
        bytes32 buyerIdentity,
        uint96 expectedPrice
    ) external onlyOperator returns (bytes32 saleId) {
        Listing storage l = listings[listingId];
        if (!l.active) revert ListingNotActive(listingId);
        if (l.price != expectedPrice) revert PriceChanged(expectedPrice, l.price);
        if (l.sellerIdentity == buyerIdentity) revert CannotBuyOwnListing();
        if (!registry.isBound(buyerIdentity)) revert BuyerNotBound(buyerIdentity);

        TicketNFT ticketContract = TicketNFT(l.ticketContract);
        TicketNFT.TicketData memory t = ticketContract.ticket(l.tokenId);
        TierPolicy memory p = ticketContract.tier(t.tierId);

        if (p.mode == ResaleMode.Bound) revert ResaleDisabled(l.tokenId);
        if (block.timestamp >= p.closesAt) revert WindowClosed(p.closesAt);
        if (l.price > ticketContract.ceilingOf(t.tierId)) {
            revert PriceAboveCeiling(ticketContract.ceilingOf(t.tierId), l.price);
        }

        // Closed before anything else happens. Everything after this line assumes
        // exactly one buyer won.
        l.active = false;
        delete activeListingOf[l.ticketContract][l.tokenId];

        saleId = keccak256(abi.encodePacked(l.ticketContract, l.tokenId, listingId, block.chainid));
        splitter.record(saleId, l.ticketContract, l.tokenId, l.price, p.splits);

        // Transfer and rebind in one call. The seller's credential stops working
        // at the exact moment the buyer's starts.
        ticketContract.controllerTransfer(l.tokenId, buyerIdentity);

        emit Sold(listingId, l.tokenId, buyerIdentity, l.price);
    }

    function ceilingFor(TicketNFT ticketContract, uint256 tokenId) external view returns (uint96) {
        return ticketContract.ceilingOf(ticketContract.ticket(tokenId).tierId);
    }
}
