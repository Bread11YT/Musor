package com.example.towerdefense;

import net.minecraft.world.item.CreativeModeTabs;
import net.minecraftforge.event.BuildCreativeModeTabContentsEvent;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;

@Mod(TowerDefenseMod.MOD_ID)
public class TowerDefenseMod {
    public static final String MOD_ID = "towerdefense";

    public TowerDefenseMod() {
        IEventBus bus = FMLJavaModLoadingContext.get().getModEventBus();
        ModBlocks.BLOCKS.register(bus);
        ModBlocks.ITEMS.register(bus);
        ModBlocks.BLOCK_ENTITIES.register(bus);
        bus.addListener(this::addCreative);
    }

    private void addCreative(BuildCreativeModeTabContentsEvent event) {
        if (event.getTabKey() == CreativeModeTabs.FUNCTIONAL_BLOCKS) {
            event.accept(ModBlocks.ARROW_TOWER_ITEM);
        }
    }
}
